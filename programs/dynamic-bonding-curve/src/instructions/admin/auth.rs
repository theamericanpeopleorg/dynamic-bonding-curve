use anchor_lang::prelude::*;

pub mod admin {
    use anchor_lang::prelude::*;

    pub const ID: Pubkey = pubkey!("MSCHFwaCxfX3kJMSRpSPo8RrFj3sZZ28c9VvUQXjyFM");
}

pub mod treasury {
    use anchor_lang::prelude::*;

    // https://app.squads.so/squads/Ff4kZLzK89T3tjMknyNHAyTU1sUzMtnbvbzuuaNvXFcZ/treasury
    pub const ID: Pubkey = pubkey!("Ff4kZLzK89T3tjMknyNHAyTU1sUzMtnbvbzuuaNvXFcZ");
}

pub mod virtual_swap_authority {
    use anchor_lang::{prelude::Pubkey, pubkey};

    pub const ID: Pubkey = pubkey!("FysG1gdSokjsc8N7rtWJYhwTNYm4fGeCiWnFjYjdbuYx");
}

#[cfg(feature = "local")]
pub fn assert_eq_admin(_admin: Pubkey) -> bool {
    true
}

#[cfg(not(feature = "local"))]
pub fn assert_eq_admin(admin: Pubkey) -> bool {
    crate::admin::admin::ID.eq(&admin)
}

#[cfg(feature = "local")]
pub fn assert_eq_virtual_swap_authority(_authority: Pubkey) -> bool {
    true
}

#[cfg(not(feature = "local"))]
pub fn assert_eq_virtual_swap_authority(authority: Pubkey) -> bool {
    crate::admin::virtual_swap_authority::ID.eq(&authority)
}
