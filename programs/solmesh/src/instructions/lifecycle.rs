use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::SolMeshError;
use crate::instructions::shared::pda_transfer_lamports;
use crate::state::{Config, Session, SessionStatus};

#[derive(Accounts)]
pub struct CancelSession<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = consumer,
        seeds = [SESSION_SEED, session.node.as_ref(), session.consumer.as_ref(), &session.session_seed.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,
    #[account(mut)]
    pub consumer: Signer<'info>,
}

/// Cancel a session that has had no usage at all (nonce == 0). Full refund.
pub fn cancel_handler(ctx: Context<CancelSession>) -> Result<()> {
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Open, SolMeshError::SessionNotOpen);
        require!(s.last_nonce == 0, SolMeshError::SessionHasUsage);
    }
    let remainder = ctx.accounts.session.deposited.checked_sub(ctx.accounts.session.settled_to_provider).ok_or(SolMeshError::MathOverflow)?;
    pda_transfer_lamports(&ctx.accounts.session.to_account_info(), &ctx.accounts.consumer.to_account_info(), remainder)?;
    ctx.accounts.session.status = SessionStatus::Cancelled;
    Ok(())
}

#[derive(Accounts)]
pub struct ExpireSession<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = consumer,
        seeds = [SESSION_SEED, session.node.as_ref(), session.consumer.as_ref(), &session.session_seed.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,
    /// CHECK: refund destination, validated via has_one.
    #[account(mut)]
    pub consumer: UncheckedAccount<'info>,
    /// Anyone can crank expiry.
    pub cranker: Signer<'info>,
}

/// After expiry with no settlement, refund the consumer the unsettled remainder.
pub fn expire_handler(ctx: Context<ExpireSession>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Open, SolMeshError::SessionNotOpen);
        require!(now > s.expiry, SolMeshError::SessionNotExpired);
    }
    let remainder = ctx.accounts.session.deposited.checked_sub(ctx.accounts.session.settled_to_provider).ok_or(SolMeshError::MathOverflow)?;
    pda_transfer_lamports(&ctx.accounts.session.to_account_info(), &ctx.accounts.consumer.to_account_info(), remainder)?;
    ctx.accounts.session.status = SessionStatus::Expired;
    Ok(())
}
