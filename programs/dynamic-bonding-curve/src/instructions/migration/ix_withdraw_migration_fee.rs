use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use num_enum::{IntoPrimitive, TryFromPrimitive};

use crate::{
    const_pda,
    state::{PoolConfig, VirtualPool, CREATOR_MIGRATION_FEE_MASK, PARTNER_MIGRATION_FEE_MASK},
    token::transfer_token_from_pool_authority,
    EvtWithdrawMigrationFee, PoolError,
};

/// Accounts for creator withdraw migration fee
#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawMigrationFeeCtx<'info> {
    /// CHECK: pool authority
    #[account(
        address = const_pda::pool_authority::ID
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(has_one = quote_mint)]
    pub config: AccountLoader<'info, PoolConfig>,

    #[account(
        mut,
        has_one = quote_vault,
        has_one = config,
    )]
    pub virtual_pool: AccountLoader<'info, VirtualPool>,

    /// The receiver token account
    #[account(mut)]
    pub token_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The vault token account for output token
    #[account(mut, token::token_program = token_quote_program, token::mint = quote_mint)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The mint of quote token
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    pub sender: Signer<'info>,

    /// Token b program
    pub token_quote_program: Interface<'info, TokenInterface>,
}

#[repr(u8)]
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    IntoPrimitive,
    TryFromPrimitive,
    AnchorDeserialize,
    AnchorSerialize,
    Default,
)]
pub enum SenderFlag {
    #[default]
    Partner,
    Creator,
}

pub fn handle_withdraw_migration_fee(
    ctx: Context<WithdrawMigrationFeeCtx>,
    flag: u8, // 0 as partner and 1 as creator
) -> Result<()> {
    let config = ctx.accounts.config.load()?;
    let mut pool = ctx.accounts.virtual_pool.load_mut()?;
    let current_timestamp = Clock::get()?.unix_timestamp as u64;

    // Make sure pool has been completed
    require!(
        pool.is_sale_complete(config.migration_quote_threshold, current_timestamp),
        PoolError::NotPermitToDoThisAction
    );
    let creator_migration_fee = 0;
    let partner_migration_fee = 0;

    let sender_flag = SenderFlag::try_from(flag).map_err(|_| PoolError::TypeCastFailed)?;
    let fee = if sender_flag == SenderFlag::Partner {
        require!(
            ctx.accounts.sender.key() == config.fee_claimer,
            PoolError::NotPermitToDoThisAction
        );
        let mask = PARTNER_MIGRATION_FEE_MASK;
        // Ensure the partner has never been withdrawn
        require!(
            pool.eligible_to_withdraw_migration_fee(mask),
            PoolError::MigrationFeeHasBeenWithdraw
        );
        // update partner withdraw migration fee
        pool.update_withdraw_migration_fee(mask);
        partner_migration_fee
    } else {
        require!(
            ctx.accounts.sender.key() == pool.creator,
            PoolError::NotPermitToDoThisAction
        );
        let mask = CREATOR_MIGRATION_FEE_MASK;
        // Ensure the creator has never been withdrawn
        require!(
            pool.eligible_to_withdraw_migration_fee(mask),
            PoolError::MigrationFeeHasBeenWithdraw
        );
        // update creator withdraw migration fee
        pool.update_withdraw_migration_fee(mask);
        creator_migration_fee
    };

    transfer_token_from_pool_authority(
        ctx.accounts.pool_authority.to_account_info(),
        &ctx.accounts.quote_mint,
        &ctx.accounts.quote_vault,
        ctx.accounts.token_quote_account.to_account_info(),
        &ctx.accounts.token_quote_program,
        fee,
    )?;

    emit_cpi!(EvtWithdrawMigrationFee {
        pool: ctx.accounts.virtual_pool.key(),
        fee,
        flag
    });
    Ok(())
}
