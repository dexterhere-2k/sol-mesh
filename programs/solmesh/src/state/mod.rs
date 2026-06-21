use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub fee_bps: u16,
    pub fee_vault: Pubkey,
    pub challenge_window_secs: i64,
    pub mpl_core_program: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Node {
    pub asset: Pubkey,
    pub provider: Pubkey,
    pub capacity: u64,
    #[max_len(64)]
    pub geo: String,
    pub reputation: u32,
    pub total_units: u64,
    pub total_sessions: u64,
    pub total_settled: u64,
    pub active: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SessionStatus {
    Open,
    Closing,
    Settled,
    Cancelled,
    Expired,
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub node: Pubkey,
    pub asset: Pubkey,
    pub provider: Pubkey,
    pub consumer: Pubkey,
    pub mint: Option<Pubkey>,      // None = native SOL escrow
    pub deposited: u64,
    pub settled_to_provider: u64,
    pub last_nonce: u64,
    pub rate_per_unit: u64,
    pub opened_at: i64,
    pub expiry: i64,
    pub status: SessionStatus,
    pub challenge_deadline: i64,
    pub pending_payout: u64,
    pub pending_units: u64,
    pub session_seed: u64,
    pub vault_bump: u8,            // bump of the SPL vault authority PDA (0 for SOL sessions)
    pub bump: u8,
}
