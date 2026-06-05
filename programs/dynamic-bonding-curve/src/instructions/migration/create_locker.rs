use crate::{
    const_pda,
    constants::seeds::BASE_LOCKER_PREFIX,
    cpi_checker::cpi_with_account_lamport_and_owner_checking,
    migration_handler::{get_migration_handler, MigratedCollectFeeMode},
    safe_math::{SafeCast, SafeMath},
    state::{MigrationOption, MigrationProgress},
    *,
};
use anchor_spl::token_interface::{TokenAccount, TokenInterface};
use locker::cpi::accounts::CreateVestingEscrowV2;

#[derive(Accounts)]
pub struct CreateLockerCtx<'info> {
    /// CHECK: pool account
    #[account(mut)]
    pub virtual_pool: UncheckedAccount<'info>,
    /// CHECK: config account
    pub config: UncheckedAccount<'info>,
    /// CHECK: pool authority
    #[account(
        mut,
        address = const_pda::pool_authority::ID,
    )]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: base_vault
    #[account(
        mut,
        token::mint = base_mint,
        token::token_program = token_program
    )]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: base token mint
    #[account(mut)]
    pub base_mint: UncheckedAccount<'info>,

    /// CHECK: base key to create locked escrow
    #[account(
        mut,
        seeds = [
            BASE_LOCKER_PREFIX.as_ref(),
            virtual_pool.key().as_ref(),
        ],
        bump,
    )]
    pub base: UncheckedAccount<'info>,
    /// CHECK: owner
    pub creator: UncheckedAccount<'info>,
    /// CHECK: escrow of locker, derived from base
    #[account(mut)]
    pub escrow: UncheckedAccount<'info>,

    /// CHECK: ATA escrow token, needs to be pre-created by the caller
    #[account(mut)]
    pub escrow_token: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: token_program
    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: Locker program
    #[account(address = locker::ID)]
    pub locker_program: UncheckedAccount<'info>,

    /// CHECK: Locker event authority
    pub locker_event_authority: UncheckedAccount<'info>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub fn handle_create_locker<'info>(ctx: Context<'info, CreateLockerCtx<'info>>) -> Result<()> {
    let pool_loader = PoolAccountLoader::try_from(&ctx.accounts.virtual_pool)?;
    let mut virtual_pool = pool_loader.load_mut()?;

    require!(
        virtual_pool.config.eq(&ctx.accounts.config.key()),
        ErrorCode::ConstraintHasOne
    );
    require!(
        virtual_pool.creator.eq(&ctx.accounts.creator.key()),
        ErrorCode::ConstraintHasOne
    );
    require!(
        virtual_pool.base_vault.eq(&ctx.accounts.base_vault.key()),
        ErrorCode::ConstraintHasOne
    );
    require!(
        virtual_pool.base_mint.eq(&ctx.accounts.base_mint.key()),
        ErrorCode::ConstraintHasOne
    );

    let config_loader = ConfigAccountLoader::try_from(&ctx.accounts.config)?;
    let config = config_loader.load()?;
    let locked_vesting_params = config.locked_vesting_config.to_locked_vesting_params();
    let current_timestamp = Clock::get()?.unix_timestamp as u64;
    let migration_progress = virtual_pool.get_migration_progress()?;
    let can_create_locker_after_deadline = migration_progress == MigrationProgress::PreBondingCurve
        && locked_vesting_params.has_vesting()
        && virtual_pool.is_deadline_reached(current_timestamp);

    require!(
        migration_progress == MigrationProgress::PostBondingCurve
            || can_create_locker_after_deadline,
        PoolError::NotPermitToDoThisAction
    );

    if can_create_locker_after_deadline {
        let migration_option = MigrationOption::try_from(config.migration_option)
            .map_err(|_| PoolError::InvalidMigrationOption)?;
        let migrated_collect_fee_mode: MigratedCollectFeeMode =
            config.migrated_collect_fee_mode.safe_cast()?;
        let liquidity_handler = get_migration_handler(
            migration_option,
            migrated_collect_fee_mode,
            virtual_pool.sqrt_price,
        );
        require!(
            virtual_pool.quote_reserve > 0,
            PoolError::InsufficientLiquidityForMigration
        );
        let (migration_base_amount, migration_quote_amount) = liquidity_handler
            .get_included_protocol_fee_migration_amounts_1(
                virtual_pool
                    .effective_migration_quote_threshold(config.get_migration_quote_amount_cap()),
                config.migration_fee_percentage,
            )?;
        require!(
            ctx.accounts
                .base_vault
                .amount
                .safe_sub(virtual_pool.get_protocol_and_trading_base_fee()?)?
                >= migration_base_amount
                && migration_base_amount > 0
                && migration_quote_amount > 0,
            PoolError::InsufficientLiquidityForMigration
        );
    }

    if virtual_pool.finish_curve_timestamp == 0 && can_create_locker_after_deadline {
        virtual_pool.finish_curve_timestamp = virtual_pool.deadline_timestamp;
    }

    let vesting_params = locked_vesting_params
        .to_create_vesting_escrow_params(virtual_pool.finish_curve_timestamp)?;

    let virtual_pool_key = ctx.accounts.virtual_pool.key();
    let base_seeds = base_locker_seeds!(virtual_pool_key, ctx.bumps.base);

    let pool_authority_seeds = pool_authority_seeds!(const_pda::pool_authority::BUMP);

    let create_locker_fn = || {
        flash_rent(
            ctx.accounts.pool_authority.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            || {
                msg!("create vesting escrow for creator");
                locker::cpi::create_vesting_escrow_v2(
                    CpiContext::new_with_signer(
                        ctx.accounts.locker_program.key(),
                        CreateVestingEscrowV2 {
                            base: ctx.accounts.base.to_account_info(), // use payer token account for base key, unique
                            escrow: ctx.accounts.escrow.to_account_info(),
                            escrow_token: ctx.accounts.escrow_token.to_account_info(),
                            token_mint: ctx.accounts.base_mint.to_account_info(),
                            sender: ctx.accounts.pool_authority.to_account_info(),
                            sender_token: ctx.accounts.base_vault.to_account_info(),
                            recipient: ctx.accounts.creator.to_account_info(),
                            token_program: ctx.accounts.token_program.to_account_info(),
                            system_program: ctx.accounts.system_program.to_account_info(),
                            event_authority: ctx.accounts.locker_event_authority.to_account_info(),
                            program: ctx.accounts.locker_program.to_account_info(),
                        },
                        &[&base_seeds[..], &pool_authority_seeds[..]],
                    ),
                    vesting_params,
                    None,
                )?;

                Ok(())
            },
        )
    };

    cpi_with_account_lamport_and_owner_checking(
        create_locker_fn,
        ctx.accounts.pool_authority.to_account_info(),
    )?;

    // set progress
    virtual_pool.set_migration_progress(MigrationProgress::LockedVesting.into());

    Ok(())
}
