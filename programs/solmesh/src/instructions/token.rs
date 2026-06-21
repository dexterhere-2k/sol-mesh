use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::constants::VAULT_SEED;

/// Move SPL tokens out of the session vault, signed by the vault authority PDA.
pub fn transfer_from_vault<'info>(
    token_program: &Program<'info, Token>,
    vault_token: &Account<'info, TokenAccount>,
    dest: &Account<'info, TokenAccount>,
    vault_authority: &AccountInfo<'info>,
    session_key: Pubkey,
    vault_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, session_key.as_ref(), &[vault_bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault_token.to_account_info(),
                to: dest.to_account_info(),
                authority: vault_authority.to_account_info(),
            },
            seeds,
        ),
        amount,
    )
}
