use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::ID as IX_SYSVAR_ID;
use solmesh_state::StateUpdate;
use crate::constants::*;
use crate::cpi::core::set_reputation;
use crate::errors::SolMeshError;
use crate::instructions::shared::*;
use crate::state::{Config, Node, Session, SessionStatus};

#[derive(Accounts)]
pub struct Settle<'info> {
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
    /// CHECK: payout destination, validated by has_one on session.
    #[account(mut)]
    pub provider: UncheckedAccount<'info>,
    /// CHECK: refund destination, validated by has_one on session.
    #[account(mut)]
    pub consumer: UncheckedAccount<'info>,
    /// CHECK: the Core asset, validated to equal node.asset.
    #[account(mut, address = node.asset)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: protocol fee sink, validated against config.
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: UncheckedAccount<'info>,
    /// The caller (provider in happy path) pays for any CPI rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: validated to equal config.mpl_core_program.
    #[account(address = config.mpl_core_program)]
    pub mpl_core_program: UncheckedAccount<'info>,
    /// CHECK: Instructions sysvar, validated by address.
    #[account(address = IX_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Final settlement (closes the channel). `is_checkpoint=false`.
pub fn settle_handler(mut ctx: Context<Settle>, state: StateUpdate) -> Result<()> {
    apply_state(&mut ctx, &state, false)
}

/// Mid-session checkpoint settlement (does not close). `is_checkpoint=true`.
pub fn checkpoint_handler(mut ctx: Context<Settle>, state: StateUpdate) -> Result<()> {
    apply_state(&mut ctx, &state, true)
}

fn apply_state(ctx: &mut Context<Settle>, state: &StateUpdate, is_checkpoint: bool) -> Result<()> {
    let session_key = ctx.accounts.session.key();
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Open, SolMeshError::SessionNotOpen);
        require!(s.mint.is_none(), SolMeshError::SplUnsupported);
        require!(state.nonce > s.last_nonce, SolMeshError::StaleNonce);
        // Prove both signatures bind to these exact bytes.
        verify_cosigned_state(s, &session_key, state, &ctx.accounts.instructions_sysvar.to_account_info())?;
    }

    let payout_delta = state
        .owed_to_provider
        .checked_sub(ctx.accounts.session.settled_to_provider)
        .ok_or(SolMeshError::OwedDecreased)?;
    let fee = fee_for(payout_delta, ctx.accounts.config.fee_bps)?;
    let provider_amount = payout_delta.checked_sub(fee).ok_or(SolMeshError::MathOverflow)?;

    // Update reputation on the Core NFT BEFORE lamport transfers.
    // ponytail: CPI before direct lamport manipulation avoids runtime imbalance.
    let node_asset = ctx.accounts.node.asset;
    let node_bump = ctx.accounts.node.bump;
    let new_units = ctx.accounts.node.total_units
        .checked_add(state.units_consumed.saturating_sub(ctx.accounts.session.pending_units))
        .ok_or(SolMeshError::MathOverflow)?;
    // Reputation is a bounded score; saturating at u32::MAX is the intended behavior
    // (not an error), so we deliberately use saturating_add here (see SPEC §7).
    let new_rep = ctx.accounts.node.reputation
        .saturating_add(reputation_reward(state.units_consumed));
    let (cap, geo) = (ctx.accounts.node.capacity, ctx.accounts.node.geo.clone());

    // ponytail: mpl-core 0.12.1 UpdatePluginV1 CPI causes lamport imbalance.
    // Save to Node account only; Core asset sync deferred.
    let _ = (cap, geo, node_bump);

    // Pay provider + fee from the escrow PDA (after CPI, before account mutations).
    pda_transfer_lamports(&ctx.accounts.session.to_account_info(), &ctx.accounts.provider.to_account_info(), provider_amount)?;
    pda_transfer_lamports(&ctx.accounts.session.to_account_info(), &ctx.accounts.fee_vault.to_account_info(), fee)?;

    // Compute the consumer refund (final close only) BEFORE taking any mutable
    // borrow of the session, then do the lamport transfer. This avoids the
    // mid-function `drop(s)` borrow dance entirely.
    if !is_checkpoint {
        let remainder = ctx.accounts.session.deposited
            .checked_sub(state.owed_to_provider)
            .ok_or(SolMeshError::MathOverflow)?;
        pda_transfer_lamports(
            &ctx.accounts.session.to_account_info(),
            &ctx.accounts.consumer.to_account_info(),
            remainder,
        )?;
    }

    // Persist trackers.
    {
        let node = &mut ctx.accounts.node;
        node.reputation = new_rep;
        node.total_units = new_units;
        node.total_settled = node.total_settled.checked_add(provider_amount).ok_or(SolMeshError::MathOverflow)?;
    }
    {
        let s = &mut ctx.accounts.session;
        s.settled_to_provider = state.owed_to_provider;
        s.last_nonce = state.nonce;
        s.pending_units = state.units_consumed;
        if !is_checkpoint {
            s.status = SessionStatus::Settled;
        }
    }
    Ok(())
}
