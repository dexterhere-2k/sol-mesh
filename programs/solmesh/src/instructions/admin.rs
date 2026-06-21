use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::constants::*;
use crate::cpi::core::set_reputation;
use crate::errors::SolMeshError;
use crate::state::{Config, Node};

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(
        mut,
        has_one = authority @ SolMeshError::Unauthorized,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

pub fn update_config_handler(ctx: Context<AdminConfig>, fee_bps: Option<u16>, challenge_window_secs: Option<i64>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(f) = fee_bps { require!(f <= MAX_FEE_BPS, SolMeshError::FeeTooHigh); c.fee_bps = f; }
    if let Some(w) = challenge_window_secs { require!(w > 0, SolMeshError::BadDuration); c.challenge_window_secs = w; }
    Ok(())
}

pub fn set_paused_handler(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(
        has_one = authority @ SolMeshError::Unauthorized,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    /// Fee vault PDA: system-owned, 0-data, holds accrued fee lamports. Uniqueness is
    /// guaranteed by the seeds/bump derivation (it equals config.fee_vault by construction).
    #[account(mut, seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault: SystemAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: destination for withdrawn fees.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn withdraw_fees_handler(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
    // The fee vault is owned by the System Program, so lamports must leave via a
    // system transfer signed by the vault PDA — not a raw lamport decrement.
    let bump = ctx.bumps.fee_vault;
    let signer: &[&[&[u8]]] = &[&[FEE_VAULT_SEED, &[bump]]];
    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.fee_vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateNodeMeta<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = provider @ SolMeshError::Unauthorized,
        seeds = [NODE_SEED, node.asset.as_ref()],
        bump = node.bump,
    )]
    pub node: Account<'info, Node>,
    /// CHECK: equals node.asset; the Node PDA is the plugin authority, so a
    /// CPI through `set_reputation` can mutate the Core Attributes plugin.
    #[account(mut, address = node.asset)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub provider: Signer<'info>,
    /// CHECK: equals config.mpl_core_program.
    #[account(address = config.mpl_core_program)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Provider may update capacity / geo / active. Reputation is program-controlled
/// and intentionally NOT exposed here (SPEC §7: "provider can update capacity/geo only").
/// When capacity/geo change, we also rewrite the Core NFT Attributes plugin via CPI
/// so the on-chain reputation source-of-truth stays in sync.
pub fn update_node_meta_handler(
    ctx: Context<UpdateNodeMeta>,
    capacity: Option<u64>,
    geo: Option<String>,
    active: Option<bool>,
) -> Result<()> {
    if let Some(c) = capacity { require!(c > 0, SolMeshError::AmountZero); ctx.accounts.node.capacity = c; }
    if let Some(g) = geo { require!(g.len() <= MAX_STRING, SolMeshError::StringTooLong); ctx.accounts.node.geo = g; }
    if let Some(a) = active { ctx.accounts.node.active = a; }

    // Snapshot the new state, then drop the mutable borrow before the CPI.
    let (new_capacity, new_geo, new_rep, new_total_units) = {
        let n = &ctx.accounts.node;
        (n.capacity, n.geo.clone(), n.reputation, n.total_units)
    };

    // CPI to Core: refresh the Attributes plugin with the (possibly new) capacity/geo
    // and the (unchanged) reputation + total_units. The Node PDA is the plugin
    // authority, so this works without the provider needing any NFT-level authority.
    let node_bump = ctx.accounts.node.bump;
    let node_asset = ctx.accounts.node.asset;
    let seeds: &[&[&[u8]]] = &[&[NODE_SEED, node_asset.as_ref(), &[node_bump]]];
    set_reputation(
        &ctx.accounts.mpl_core_program.to_account_info(),
        &ctx.accounts.asset.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.node.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        new_capacity,
        new_geo,
        new_rep,
        new_total_units,
        seeds,
    )?;
    Ok(())
}
