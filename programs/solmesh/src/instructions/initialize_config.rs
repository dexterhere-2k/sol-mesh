use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::SolMeshError;
use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    /// CHECK: PDA that simply holds accrued protocol fees as lamports.
    #[account(mut, seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    fee_bps: u16,
    challenge_window_secs: i64,
    mpl_core_program: Pubkey,
) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, SolMeshError::FeeTooHigh);
    require!(challenge_window_secs > 0, SolMeshError::BadDuration);
    let c = &mut ctx.accounts.config;
    c.authority = ctx.accounts.authority.key();
    c.fee_bps = fee_bps;
    c.fee_vault = ctx.accounts.fee_vault.key();
    c.challenge_window_secs = challenge_window_secs;
    c.mpl_core_program = mpl_core_program;
    c.paused = false;
    c.bump = ctx.bumps.config;
    Ok(())
}
