use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::constants::*;
use crate::errors::SolMeshError;
use crate::state::{Config, Node, Session, SessionStatus};

#[derive(Accounts)]
#[instruction(session_seed: u64)]
pub struct OpenSession<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [NODE_SEED, node.asset.as_ref()],
        bump = node.bump,
        constraint = node.active @ SolMeshError::NodeInactive,
    )]
    pub node: Account<'info, Node>,
    #[account(
        init,
        payer = consumer,
        space = 8 + Session::INIT_SPACE,
        seeds = [SESSION_SEED, node.key().as_ref(), consumer.key().as_ref(), &session_seed.to_le_bytes()],
        bump
    )]
    pub session: Account<'info, Session>,
    #[account(mut)]
    pub consumer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<OpenSession>,
    session_seed: u64,
    amount: u64,
    duration_secs: i64,
    rate_per_unit: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, SolMeshError::Paused);
    require!(amount > 0, SolMeshError::AmountZero);
    require!((MIN_DURATION_SECS..=MAX_DURATION_SECS).contains(&duration_secs), SolMeshError::BadDuration);

    // Lock SOL into the session PDA (the escrow).
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.consumer.to_account_info(),
                to: ctx.accounts.session.to_account_info(),
            },
        ),
        amount,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let s = &mut ctx.accounts.session;
    s.node = ctx.accounts.node.key();
    s.asset = ctx.accounts.node.asset;
    s.provider = ctx.accounts.node.provider;
    s.consumer = ctx.accounts.consumer.key();
    s.mint = None;
    s.deposited = amount;
    s.settled_to_provider = 0;
    s.last_nonce = 0;
    s.rate_per_unit = rate_per_unit;
    s.opened_at = now;
    s.expiry = now.checked_add(duration_secs).ok_or(SolMeshError::MathOverflow)?;
    s.status = SessionStatus::Open;
    s.challenge_deadline = 0;
    s.pending_payout = 0;
    s.pending_units = 0;
    s.session_seed = session_seed;
    s.vault_bump = 0; // SOL path has no SPL vault
    s.bump = ctx.bumps.session;

    let node = &mut ctx.accounts.node;
    node.total_sessions = node.total_sessions.checked_add(1).ok_or(SolMeshError::MathOverflow)?;
    Ok(())
}
