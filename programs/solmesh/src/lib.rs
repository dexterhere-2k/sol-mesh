//! SolMesh — DePIN state settler.
//! See SPEC.md for the full architecture. Build order: M0..M9.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod state;
pub mod crypto;
pub mod cpi;
pub mod instructions;

use instructions::*;
use solmesh_state::StateUpdate;

declare_id!("22RMtywvuM1XDTLpwvKgjP8gfuW1BWq7vDX3gxsTPGMU");

#[program]
pub mod solmesh {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, fee_bps: u16, challenge_window_secs: i64, mpl_core_program: Pubkey) -> Result<()> {
        initialize_config::handler(ctx, fee_bps, challenge_window_secs, mpl_core_program)
    }

    pub fn register_node(ctx: Context<RegisterNode>, name: String, uri: String, capacity: u64, geo: String, init_reputation: u32) -> Result<()> {
        register_node::handler(ctx, name, uri, capacity, geo, init_reputation)
    }

    pub fn open_session(ctx: Context<OpenSession>, session_seed: u64, amount: u64, duration_secs: i64, rate_per_unit: u64) -> Result<()> {
        open_session::handler(ctx, session_seed, amount, duration_secs, rate_per_unit)
    }

    pub fn checkpoint_settle(ctx: Context<Settle>, state: StateUpdate) -> Result<()> {
        settle::checkpoint_handler(ctx, state)
    }

    pub fn settle_session(ctx: Context<Settle>, state: StateUpdate) -> Result<()> {
        settle::settle_handler(ctx, state)
    }

    pub fn initiate_unilateral_close(ctx: Context<UnilateralClose>, state: StateUpdate) -> Result<()> {
        dispute::initiate_handler(ctx, state)
    }

    pub fn challenge(ctx: Context<UnilateralClose>, state: StateUpdate) -> Result<()> {
        dispute::challenge_handler(ctx, state)
    }

    pub fn finalize_close(ctx: Context<FinalizeClose>) -> Result<()> {
        dispute::finalize_handler(ctx)
    }

    pub fn cancel_session(ctx: Context<CancelSession>) -> Result<()> {
        lifecycle::cancel_handler(ctx)
    }

    pub fn expire_session(ctx: Context<ExpireSession>) -> Result<()> {
        lifecycle::expire_handler(ctx)
    }

    // ---- admin ----
    pub fn update_config(ctx: Context<AdminConfig>, fee_bps: Option<u16>, challenge_window_secs: Option<i64>) -> Result<()> {
        admin::update_config_handler(ctx, fee_bps, challenge_window_secs)
    }
    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        admin::set_paused_handler(ctx, paused)
    }
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        admin::withdraw_fees_handler(ctx, amount)
    }
    pub fn update_node_meta(ctx: Context<UpdateNodeMeta>, capacity: Option<u64>, geo: Option<String>, active: Option<bool>) -> Result<()> {
        admin::update_node_meta_handler(ctx, capacity, geo, active)
    }

    // ---- SPL / USDC escrow path (M8) ----
    pub fn open_session_spl(ctx: Context<OpenSessionSpl>, session_seed: u64, amount: u64, duration_secs: i64, rate_per_unit: u64) -> Result<()> {
        spl::open_session_spl_handler(ctx, session_seed, amount, duration_secs, rate_per_unit)
    }
    pub fn checkpoint_settle_spl(ctx: Context<SettleSpl>, state: StateUpdate) -> Result<()> {
        spl::checkpoint_spl_handler(ctx, state)
    }
    pub fn settle_session_spl(ctx: Context<SettleSpl>, state: StateUpdate) -> Result<()> {
        spl::settle_spl_handler(ctx, state)
    }
    pub fn finalize_close_spl(ctx: Context<FinalizeCloseSpl>) -> Result<()> {
        spl::finalize_close_spl_handler(ctx)
    }
    pub fn cancel_session_spl(ctx: Context<LifecycleSpl>) -> Result<()> {
        spl::cancel_session_spl_handler(ctx)
    }
    pub fn expire_session_spl(ctx: Context<LifecycleSpl>) -> Result<()> {
        spl::expire_session_spl_handler(ctx)
    }
}
