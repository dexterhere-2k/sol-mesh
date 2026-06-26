//! On-chain verification that a given ed25519 signature exists in the transaction.
//!
//! Solana has no cheap in-program ed25519 verify. The canonical pattern:
//!   1. The client adds native `Ed25519Program` instructions BEFORE the settle ix.
//!      The runtime precompile verifies the signature math; an invalid sig aborts
//!      the whole transaction before our program executes.
//!   2. Here we use Instructions-sysvar introspection to PROVE such an instruction
//!      exists and binds exactly (expected_pubkey, expected_message). We are checking
//!      *binding*, not the curve math (the precompile already did that).
//!
//! We only accept SELF-CONTAINED ed25519 instructions (pubkey + msg + sig all inside
//! the same instruction's data), which is what `Ed25519Program.createInstructionWith*`
//! in @solana/web3.js produces. Self-contained instructions use the u16::MAX sentinel
//! for every `*_instruction_index`. Anything else is rejected (Ed25519CrossIndex).

use crate::errors::SolMeshError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

const PUBKEY_SIZE: usize = 32;
const SIG_SIZE: usize = 64;
const HEADER: usize = 2; // num_signatures (u8) + padding (u8)
const OFFSETS_SIZE: usize = 14; // one Ed25519SignatureOffsets struct
const SENTINEL: u16 = u16::MAX; // "this instruction"

/// Scan the transaction for a self-contained ed25519 instruction that binds
/// `expected_pubkey` to `expected_msg`. Returns Ok(()) if found.
pub fn verify_ed25519_signature(
    ix_sysvar: &AccountInfo,
    expected_pubkey: &[u8; 32],
    expected_msg: &[u8],
) -> Result<()> {
    let current = load_current_index_checked(ix_sysvar)? as usize;
    for i in 0..current {
        let ix = match load_instruction_at_checked(i, ix_sysvar) {
            Ok(ix) => ix,
            Err(_) => continue,
        };
        if ix.program_id != ED25519_PROGRAM_ID {
            continue;
        }
        if check_ed25519_data(&ix.data, expected_pubkey, expected_msg).is_ok() {
            return Ok(());
        }
    }
    err!(SolMeshError::Ed25519IxMissing)
}

fn read_u16(data: &[u8], at: usize) -> Result<u16> {
    require!(at + 2 <= data.len(), SolMeshError::Ed25519IxMissing);
    Ok(u16::from_le_bytes([data[at], data[at + 1]]))
}

/// Parse one self-contained signature entry and compare pubkey + message.
fn check_ed25519_data(data: &[u8], pk: &[u8; 32], msg: &[u8]) -> Result<()> {
    require!(
        data.len() >= HEADER + OFFSETS_SIZE,
        SolMeshError::Ed25519IxMissing
    );
    let num_sigs = data[0];
    require!(num_sigs >= 1, SolMeshError::Ed25519IxMissing);

    let o = HEADER;
    let sig_offset = read_u16(data, o)? as usize;
    let sig_ix_idx = read_u16(data, o + 2)?;
    let pk_offset = read_u16(data, o + 4)? as usize;
    let pk_ix_idx = read_u16(data, o + 6)?;
    let msg_offset = read_u16(data, o + 8)? as usize;
    let msg_size = read_u16(data, o + 10)? as usize;
    let msg_ix_idx = read_u16(data, o + 12)?;

    // Reject cross-instruction references — only self-contained instructions allowed.
    require!(
        sig_ix_idx == SENTINEL && pk_ix_idx == SENTINEL && msg_ix_idx == SENTINEL,
        SolMeshError::Ed25519CrossIndex
    );

    // Bounds.
    require!(
        pk_offset + PUBKEY_SIZE <= data.len(),
        SolMeshError::Ed25519IxMissing
    );
    require!(
        sig_offset + SIG_SIZE <= data.len(),
        SolMeshError::Ed25519IxMissing
    );
    require!(
        msg_offset + msg_size <= data.len(),
        SolMeshError::Ed25519IxMissing
    );

    // Compare pubkey.
    require!(
        &data[pk_offset..pk_offset + PUBKEY_SIZE] == pk,
        SolMeshError::Ed25519PubkeyMismatch
    );
    // Compare message bytes exactly (length + content).
    require!(msg_size == msg.len(), SolMeshError::Ed25519MessageMismatch);
    require!(
        &data[msg_offset..msg_offset + msg_size] == msg,
        SolMeshError::Ed25519MessageMismatch
    );

    Ok(())
}
