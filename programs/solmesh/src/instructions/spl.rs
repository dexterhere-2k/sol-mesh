//! SPL / USDC escrow path (SPEC §1 D4, M8). Mirrors the SOL instructions but routes
//! funds through a PDA-owned vault ATA. The off-chain protocol, signature verification,
//! fee/reputation math, and dispute initiate/challenge are all shared with the SOL path;
//! only fund custody differs. `initiate_unilateral_close` / `challenge` are fund-agnostic
//! and reused as-is — only the terminal payout instructions are duplicated here.
//!
//! NOTE: this is the least compile-verified module (added last, per the gap analysis).
//! Validate the anchor_spl 0.30 account-constraint syntax on first `anchor build`.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solmesh_state::StateUpdate;

use crate::constants::*;
use crate::cpi::core::set_reputation;
use crate::errors::SolMeshError;
use crate::instructions::shared::{fee_for, reputation_reward, verify_cosigned_state};
use crate::instructions::token::transfer_from_vault;
use crate::state::{Config, Node, Session, SessionStatus};
use anchor_lang::solana_program::sysvar::instructions::ID as IX_SYSVAR_ID;

// ---------------------------------------------------------------- open_session_spl

#[derive(Accounts)]
#[instruction(session_seed: u64)]
pub struct OpenSessionSpl<'info> {
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
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = consumer_token.mint == mint.key() @ SolMeshError::SplUnsupported,
        constraint = consumer_token.owner == consumer.key() @ SolMeshError::Unauthorized,
    )]
    pub consumer_token: Account<'info, TokenAccount>,
    /// CHECK: vault authority PDA (owns the vault ATA).
    #[account(seeds = [VAULT_SEED, session.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = consumer,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub consumer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn open_session_spl_handler(
    ctx: Context<OpenSessionSpl>,
    session_seed: u64,
    amount: u64,
    duration_secs: i64,
    rate_per_unit: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, SolMeshError::Paused);
    require!(amount > 0, SolMeshError::AmountZero);
    require!((MIN_DURATION_SECS..=MAX_DURATION_SECS).contains(&duration_secs), SolMeshError::BadDuration);

    // Lock tokens into the vault ATA.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.consumer_token.to_account_info(),
                to: ctx.accounts.vault_token.to_account_info(),
                authority: ctx.accounts.consumer.to_account_info(),
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
    s.mint = Some(ctx.accounts.mint.key());
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
    s.vault_bump = ctx.bumps.vault_authority;
    s.bump = ctx.bumps.session;

    let node = &mut ctx.accounts.node;
    node.total_sessions = node.total_sessions.checked_add(1).ok_or(SolMeshError::MathOverflow)?;
    Ok(())
}

// ---------------------------------------------------------------- settle / checkpoint (SPL)

#[derive(Accounts)]
pub struct SettleSpl<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [NODE_SEED, node.asset.as_ref()], bump = node.bump)]
    pub node: Account<'info, Node>,
    #[account(
        mut,
        has_one = node, has_one = provider, has_one = consumer,
        seeds = [SESSION_SEED, session.node.as_ref(), session.consumer.as_ref(), &session.session_seed.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,
    /// CHECK: validated by has_one.
    pub provider: UncheckedAccount<'info>,
    /// CHECK: validated by has_one.
    pub consumer: UncheckedAccount<'info>,
    /// CHECK: equals node.asset.
    #[account(mut, address = node.asset)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: vault authority PDA.
    #[account(seeds = [VAULT_SEED, session.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, constraint = provider_token.owner == provider.key() @ SolMeshError::Unauthorized)]
    pub provider_token: Account<'info, TokenAccount>,
    #[account(mut, constraint = consumer_token.owner == consumer.key() @ SolMeshError::Unauthorized)]
    pub consumer_token: Account<'info, TokenAccount>,
    /// Fee destination token account, owned by the protocol fee vault PDA.
    #[account(mut, constraint = fee_token.owner == config.fee_vault @ SolMeshError::Unauthorized)]
    pub fee_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: equals config.mpl_core_program.
    #[account(address = config.mpl_core_program)]
    pub mpl_core_program: UncheckedAccount<'info>,
    /// CHECK: Instructions sysvar.
    #[account(address = IX_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn settle_spl_handler(ctx: Context<SettleSpl>, state: StateUpdate) -> Result<()> {
    apply_state_spl(ctx, &state, false)
}
pub fn checkpoint_spl_handler(ctx: Context<SettleSpl>, state: StateUpdate) -> Result<()> {
    apply_state_spl(ctx, &state, true)
}

fn apply_state_spl(ctx: Context<SettleSpl>, state: &StateUpdate, is_checkpoint: bool) -> Result<()> {
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Open, SolMeshError::SessionNotOpen);
        require!(s.mint.is_some(), SolMeshError::SplUnsupported);
        require!(state.nonce > s.last_nonce, SolMeshError::StaleNonce);
        verify_cosigned_state(s, state, &ctx.accounts.instructions_sysvar.to_account_info())?;
    }

    let payout_delta = state
        .owed_to_provider
        .checked_sub(ctx.accounts.session.settled_to_provider)
        .ok_or(SolMeshError::OwedDecreased)?;
    let fee = fee_for(payout_delta, ctx.accounts.config.fee_bps)?;
    let provider_amount = payout_delta.checked_sub(fee).ok_or(SolMeshError::MathOverflow)?;

    let session_key = ctx.accounts.session.key();
    let vault_bump = ctx.accounts.session.vault_bump;
    transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault_token, &ctx.accounts.provider_token, &ctx.accounts.vault_authority.to_account_info(), session_key, vault_bump, provider_amount)?;
    transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault_token, &ctx.accounts.fee_token, &ctx.accounts.vault_authority.to_account_info(), session_key, vault_bump, fee)?;

    // Reputation update (shared).
    let node_asset = ctx.accounts.node.asset;
    let node_bump = ctx.accounts.node.bump;
    let new_units = ctx.accounts.node.total_units
        .checked_add(state.units_consumed.saturating_sub(ctx.accounts.session.pending_units))
        .ok_or(SolMeshError::MathOverflow)?;
    let new_rep = ctx.accounts.node.reputation.saturating_add(reputation_reward(state.units_consumed));
    let (cap, geo) = (ctx.accounts.node.capacity, ctx.accounts.node.geo.clone());
    let seeds: &[&[&[u8]]] = &[&[NODE_SEED, node_asset.as_ref(), &[node_bump]]];
    set_reputation(
        &ctx.accounts.mpl_core_program.to_account_info(),
        &ctx.accounts.asset.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.node.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        cap, geo, new_rep, new_units, seeds,
    )?;

    if !is_checkpoint {
        let remainder = ctx.accounts.session.deposited.checked_sub(state.owed_to_provider).ok_or(SolMeshError::MathOverflow)?;
        transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault_token, &ctx.accounts.consumer_token, &ctx.accounts.vault_authority.to_account_info(), session_key, vault_bump, remainder)?;
    }

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

// ---------------------------------------------------------------- finalize_close (SPL)

#[derive(Accounts)]
pub struct FinalizeCloseSpl<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [NODE_SEED, node.asset.as_ref()], bump = node.bump)]
    pub node: Account<'info, Node>,
    #[account(
        mut,
        has_one = node, has_one = provider, has_one = consumer,
        seeds = [SESSION_SEED, session.node.as_ref(), session.consumer.as_ref(), &session.session_seed.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,
    /// CHECK: validated by has_one.
    pub provider: UncheckedAccount<'info>,
    /// CHECK: validated by has_one.
    pub consumer: UncheckedAccount<'info>,
    /// CHECK: equals node.asset.
    #[account(mut, address = node.asset)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: vault authority PDA.
    #[account(seeds = [VAULT_SEED, session.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, constraint = provider_token.owner == provider.key() @ SolMeshError::Unauthorized)]
    pub provider_token: Account<'info, TokenAccount>,
    #[account(mut, constraint = consumer_token.owner == consumer.key() @ SolMeshError::Unauthorized)]
    pub consumer_token: Account<'info, TokenAccount>,
    #[account(mut, constraint = fee_token.owner == config.fee_vault @ SolMeshError::Unauthorized)]
    pub fee_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: equals config.mpl_core_program.
    #[account(address = config.mpl_core_program)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn finalize_close_spl_handler(ctx: Context<FinalizeCloseSpl>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Closing, SolMeshError::SessionNotClosing);
        require!(s.mint.is_some(), SolMeshError::SplUnsupported);
        require!(now > s.challenge_deadline, SolMeshError::ChallengeWindowOpen);
    }
    let owed = ctx.accounts.session.pending_payout;
    let units = ctx.accounts.session.pending_units;
    let payout_delta = owed.checked_sub(ctx.accounts.session.settled_to_provider).ok_or(SolMeshError::OwedDecreased)?;
    let fee = fee_for(payout_delta, ctx.accounts.config.fee_bps)?;
    let provider_amount = payout_delta.checked_sub(fee).ok_or(SolMeshError::MathOverflow)?;

    let session_key = ctx.accounts.session.key();
    let vault_bump = ctx.accounts.session.vault_bump;
    transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault_token, &ctx.accounts.provider_token, &ctx.accounts.vault_authority.to_account_info(), session_key, vault_bump, provider_amount)?;
    transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault_token, &ctx.accounts.fee_token, &ctx.accounts.vault_authority.to_account_info(), session_key, vault_bump, fee)?;

    let node_asset = ctx.accounts.node.asset;
    let node_bump = ctx.accounts.node.bump;
    let new_units = ctx.accounts.node.total_units.checked_add(units).ok_or(SolMeshError::MathOverflow)?;
    let new_rep = ctx.accounts.node.reputation.saturating_add(reputation_reward(units));
    let (cap, geo) = (ctx.accounts.node.capacity, ctx.accounts.node.geo.clone());
    let seeds: &[&[&[u8]]] = &[&[NODE_SEED, node_asset.as_ref(), &[node_bump]]];
    set_reputation(
        &ctx.accounts.mpl_core_program.to_account_info(),
        &ctx.accounts.asset.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.node.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        cap, geo, new_rep, new_units, seeds,
    )?;

    let remainder = ctx.accounts.session.deposited.checked_sub(owed).ok_or(SolMeshError::MathOverflow)?;
    transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault_token, &ctx.accounts.consumer_token, &ctx.accounts.vault_authority.to_account_info(), session_key, vault_bump, remainder)?;

    {
        let node = &mut ctx.accounts.node;
        node.reputation = new_rep;
        node.total_units = new_units;
        node.total_settled = node.total_settled.checked_add(provider_amount).ok_or(SolMeshError::MathOverflow)?;
    }
    ctx.accounts.session.settled_to_provider = owed;
    ctx.accounts.session.status = SessionStatus::Settled;
    Ok(())
}

// ---------------------------------------------------------------- cancel / expire (SPL)

#[derive(Accounts)]
pub struct LifecycleSpl<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = consumer,
        seeds = [SESSION_SEED, session.node.as_ref(), session.consumer.as_ref(), &session.session_seed.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,
    /// CHECK: validated by has_one.
    pub consumer: UncheckedAccount<'info>,
    /// CHECK: vault authority PDA.
    #[account(seeds = [VAULT_SEED, session.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, constraint = consumer_token.owner == consumer.key() @ SolMeshError::Unauthorized)]
    pub consumer_token: Account<'info, TokenAccount>,
    /// Either consumer (cancel) or anyone (expire); checked in handlers.
    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn cancel_session_spl_handler(ctx: Context<LifecycleSpl>) -> Result<()> {
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Open, SolMeshError::SessionNotOpen);
        require!(s.mint.is_some(), SolMeshError::SplUnsupported);
        require!(s.last_nonce == 0, SolMeshError::SessionHasUsage);
        require!(ctx.accounts.signer.key() == s.consumer, SolMeshError::Unauthorized);
    }
    let remainder = ctx.accounts.session.deposited.checked_sub(ctx.accounts.session.settled_to_provider).ok_or(SolMeshError::MathOverflow)?;
    let session_key = ctx.accounts.session.key();
    let vault_bump = ctx.accounts.session.vault_bump;
    transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault_token, &ctx.accounts.consumer_token, &ctx.accounts.vault_authority.to_account_info(), session_key, vault_bump, remainder)?;
    ctx.accounts.session.status = SessionStatus::Cancelled;
    Ok(())
}

pub fn expire_session_spl_handler(ctx: Context<LifecycleSpl>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let s = &ctx.accounts.session;
        require!(s.status == SessionStatus::Open, SolMeshError::SessionNotOpen);
        require!(s.mint.is_some(), SolMeshError::SplUnsupported);
        require!(now > s.expiry, SolMeshError::SessionNotExpired);
    }
    let remainder = ctx.accounts.session.deposited.checked_sub(ctx.accounts.session.settled_to_provider).ok_or(SolMeshError::MathOverflow)?;
    let session_key = ctx.accounts.session.key();
    let vault_bump = ctx.accounts.session.vault_bump;
    transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault_token, &ctx.accounts.consumer_token, &ctx.accounts.vault_authority.to_account_info(), session_key, vault_bump, remainder)?;
    ctx.accounts.session.status = SessionStatus::Expired;
    Ok(())
}
