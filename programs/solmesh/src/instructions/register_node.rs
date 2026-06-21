use anchor_lang::prelude::*;
use crate::constants::*;
use crate::cpi::core::create_node_asset;
use crate::errors::SolMeshError;
use crate::state::{Config, Node};

#[derive(Accounts)]
pub struct RegisterNode<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = provider,
        space = 8 + Node::INIT_SPACE,
        seeds = [NODE_SEED, asset.key().as_ref()],
        bump
    )]
    pub node: Account<'info, Node>,
    /// The new Core asset (must sign — it is a fresh keypair).
    #[account(mut)]
    pub asset: Signer<'info>,
    #[account(mut)]
    pub provider: Signer<'info>,
    /// CHECK: validated to equal config.mpl_core_program.
    #[account(address = config.mpl_core_program)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterNode>,
    name: String,
    uri: String,
    capacity: u64,
    geo: String,
    init_reputation: u32,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, SolMeshError::Paused);
    require!(name.len() <= MAX_STRING && geo.len() <= MAX_STRING && uri.len() <= 200, SolMeshError::StringTooLong);
    require!(capacity > 0, SolMeshError::AmountZero);

    let asset_key = ctx.accounts.asset.key();
    let bump = ctx.bumps.node;
    let seeds: &[&[&[u8]]] = &[&[NODE_SEED, asset_key.as_ref(), &[bump]]];

    create_node_asset(
        &ctx.accounts.mpl_core_program.to_account_info(),
        &ctx.accounts.asset.to_account_info(),
        &ctx.accounts.provider.to_account_info(),
        &ctx.accounts.provider.to_account_info(),         // owner = provider
        &ctx.accounts.node.to_account_info(),             // update authority = node PDA
        &ctx.accounts.system_program.to_account_info(),
        name, uri, capacity, geo.clone(), init_reputation,
        seeds,
    )?;

    let node = &mut ctx.accounts.node;
    node.asset = asset_key;
    node.provider = ctx.accounts.provider.key();
    node.capacity = capacity;
    node.geo = geo;
    node.reputation = init_reputation;
    node.total_units = 0;
    node.total_sessions = 0;
    node.total_settled = 0;
    node.active = true;
    node.bump = bump;
    Ok(())
}
