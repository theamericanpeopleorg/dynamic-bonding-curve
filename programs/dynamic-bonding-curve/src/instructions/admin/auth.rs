use anchor_lang::prelude::*;

pub mod admin {
    use anchor_lang::prelude::*;

    pub const ADMINS: [Pubkey; 2] = [
        pubkey!("5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi"),
        pubkey!("DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX"),
    ];
}

pub mod treasury {
    use anchor_lang::prelude::*;

    // https://app.squads.so/squads/6aYhxiNGmG8AyU25rh2R7iFu4pBrqnQHpNUGhmsEXRcm/treasury
    pub const ID: Pubkey = pubkey!("6aYhxiNGmG8AyU25rh2R7iFu4pBrqnQHpNUGhmsEXRcm");
}

pub mod virtual_swap_authority {
    use anchor_lang::{prelude::Pubkey, pubkey};

    // TODO: Replace with the production Privy backend signer before non-local deployment.
    pub const ID: Pubkey = pubkey!("11111111111111111111111111111111");
}

#[cfg(feature = "local")]
pub fn assert_eq_admin(_admin: Pubkey) -> bool {
    true
}

#[cfg(not(feature = "local"))]
pub fn assert_eq_admin(admin: Pubkey) -> bool {
    crate::admin::admin::ADMINS
        .iter()
        .any(|predefined_admin| predefined_admin.eq(&admin))
}

#[cfg(feature = "local")]
pub fn assert_eq_virtual_swap_authority(_authority: Pubkey) -> bool {
    true
}

#[cfg(not(feature = "local"))]
pub fn assert_eq_virtual_swap_authority(authority: Pubkey) -> bool {
    crate::admin::virtual_swap_authority::ID.eq(&authority)
}
