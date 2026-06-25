use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const NODE_SEED: &[u8] = b"node";
#[constant]
pub const SESSION_SEED: &[u8] = b"session";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";

pub const MAX_FEE_BPS: u16 = 1_000;          // 10%
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_STRING: usize = 64;
pub const MIN_DURATION_SECS: i64 = 1;
pub const MAX_DURATION_SECS: i64 = 60 * 60 * 24 * 30; // 30 days

// Reputation tuning
pub const REP_BASE_REWARD: u32 = 1;
pub const REP_UNIT_SCALE: u64 = 1_000;       // +1 rep per 1000 units, capped
pub const REP_MAX_BONUS: u32 = 10;
pub const REP_ABANDON_PENALTY: u32 = 2;

// On-NFT attribute keys (Attributes plugin)
pub const ATTR_CAPACITY: &str = "capacity";
pub const ATTR_GEO: &str = "geo";
pub const ATTR_REPUTATION: &str = "reputation";
pub const ATTR_TOTAL_UNITS: &str = "total_units";
