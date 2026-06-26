use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::ID as IX_SYSVAR_ID;
use solmesh_state::StateUpdate;
use crate::constants::*;
use crate::cpi::core::set_reputation;
use crate::errors::SolMeshError;
use crate::instructions::shared::*;
use crate::state::{Config, Node, Session, SessionStatus};

#[derive(Accounts)]
pub struct UnilateralClose<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = provider,
        has_one = consumer,
        seeds = [SESSION_SEED, session.node.as_ref(), session.consumer.as_ref(), &session.session_seed.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,
    /// CHECK: validated via has_one.
    pub provider: UncheckedAccount<'info>,
    /// CHECK: validated via has_one.
    pub consumer: UncheckedAccount<'info>,
    /// Either party may initiate / challenge.
    pub caller: Signer<'info>,
    /// CHECK: Instructions sysvar.
    #[account(address = IX_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// Start a unilateral close with the best co-signed state the caller holds.
pub fn initiate_handler(ctx: Context<UnilateralClose>, state: StateUpdate) -> Result<()> {
    let caller = ctx.accounts.caller.key();
    let session_key = ctx.accounts.session.key();
    require!(
        caller == ctx.accounts.session.provider || caller == ctx.accounts.session.consumer,
        SolMeshError::Unauthorized
    );
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Open, SolMeshError::SessionNotOpen);
        require!(state.nonce > s.last_nonce, SolMeshError::StaleNonce);
        verify_cosigned_state(s, &session_key, &state, &ctx.accounts.instructions_sysvar.to_account_info())?;
    }
    let now = Clock::get()?.unix_timestamp;
    let s = &mut ctx.accounts.session;
    s.status = SessionStatus::Closing;
    s.last_nonce = state.nonce;
    s.pending_payout = state.owed_to_provider;
    s.pending_units = state.units_consumed;
    s.challenge_deadline = now.checked_add(ctx.accounts.config.challenge_window_secs).ok_or(SolMeshError::MathOverflow)?;
    Ok(())
}

/// Counterparty posts a higher-nonce co-signed state during the window.
pub fn challenge_handler(ctx: Context<UnilateralClose>, state: StateUpdate) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let session_key = ctx.accounts.session.key();
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Closing, SolMeshError::SessionNotClosing);
        require!(now <= s.challenge_deadline, SolMeshError::ChallengeWindowClosed);
        require!(state.nonce > s.last_nonce, SolMeshError::NonceNotIncreasing);
        verify_cosigned_state(s, &session_key, &state, &ctx.accounts.instructions_sysvar.to_account_info())?;
    }
    let s = &mut ctx.accounts.session;
    s.last_nonce = state.nonce;
    s.pending_payout = state.owed_to_provider;
    s.pending_units = state.units_consumed;
    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeClose<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [NODE_SEED, node.asset.as_ref()],
        bump = node.bump,
    )]
    pub node: Account<'info, Node>,
    #[account(
        mut,
        has_one = node,
        has_one = provider,
        has_one = consumer,
        seeds = [SESSION_SEED, session.node.as_ref(), session.consumer.as_ref(), &session.session_seed.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,
    /// CHECK: validated via has_one.
    #[account(mut)]
    pub provider: UncheckedAccount<'info>,
    /// CHECK: validated via has_one.
    #[account(mut)]
    pub consumer: UncheckedAccount<'info>,
    /// CHECK: equals node.asset.
    #[account(mut, address = node.asset)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: equals config.fee_vault.
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: equals config.mpl_core_program.
    #[account(address = config.mpl_core_program)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// After the challenge window, distribute using the highest accepted state.
pub fn finalize_handler(ctx: Context<FinalizeClose>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Closing, SolMeshError::SessionNotClosing);
        require!(now > s.challenge_deadline, SolMeshError::ChallengeWindowOpen);
    }
    let owed = ctx.accounts.session.pending_payout;
    let units = ctx.accounts.session.pending_units;
    let payout_delta = owed.checked_sub(ctx.accounts.session.settled_to_provider).ok_or(SolMeshError::OwedDecreased)?;
    let fee = fee_for(payout_delta, ctx.accounts.config.fee_bps)?;
    let provider_amount = payout_delta.checked_sub(fee).ok_or(SolMeshError::MathOverflow)?;

    pda_transfer_lamports(&ctx.accounts.session.to_account_info(), &ctx.accounts.provider.to_account_info(), provider_amount)?;
    pda_transfer_lamports(&ctx.accounts.session.to_account_info(), &ctx.accounts.fee_vault.to_account_info(), fee)?;

    let node_asset = ctx.accounts.node.asset;
    let node_bump = ctx.accounts.node.bump;
    let new_units = ctx.accounts.node.total_units.checked_add(units).ok_or(SolMeshError::MathOverflow)?;
    let new_rep = ctx.accounts.node.reputation.saturating_add(reputation_reward(units));
    let (cap, geo) = (ctx.accounts.node.capacity, ctx.accounts.node.geo.clone());

    // ponytail: mpl-core 0.12.1 UpdatePluginV1 CPI causes lamport imbalance.
    // Save to Node account only; Core asset sync deferred.
    let _ = (cap, geo, node_bump, node_asset);


    {
        let node = &mut ctx.accounts.node;
        node.reputation = new_rep;
        node.total_units = new_units;
        node.total_settled = node.total_settled.checked_add(provider_amount).ok_or(SolMeshError::MathOverflow)?;
    }
    let remainder = ctx.accounts.session.deposited.checked_sub(owed).ok_or(SolMeshError::MathOverflow)?;
    pda_transfer_lamports(&ctx.accounts.session.to_account_info(), &ctx.accounts.consumer.to_account_info(), remainder)?;
    ctx.accounts.session.settled_to_provider = owed;
    ctx.accounts.session.status = SessionStatus::Settled;
    Ok(())
}
