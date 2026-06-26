use anchor_lang::prelude::*;
use solmesh_state::{StateUpdate, STATE_DOMAIN};
use crate::crypto::ed25519::verify_ed25519_signature;
use crate::errors::SolMeshError;
use crate::state::Session;

/// Validate a co-signed StateUpdate against a session and prove both ed25519
/// signatures exist in the transaction. Returns the parsed StateUpdate.
pub fn verify_cosigned_state(
    session: &Session,
    session_key: &Pubkey,
    state: &StateUpdate,
    ix_sysvar: &AccountInfo,
) -> Result<()> {
    require!(state.has_valid_domain(), SolMeshError::DomainMismatch);
    require!(state.domain == STATE_DOMAIN, SolMeshError::DomainMismatch);
    // Binds this state to exactly this session escrow.
    require!(state.session == session_key.to_bytes(), SolMeshError::SignerMismatch);
    require!(state.owed_to_provider <= session.deposited, SolMeshError::OwedExceedsDeposit);
    require!(state.owed_to_provider >= session.settled_to_provider, SolMeshError::OwedDecreased);

    let msg = state.to_message_bytes();
    // Both the provider AND the consumer must have signed these exact bytes.
    verify_ed25519_signature(ix_sysvar, &session.provider.to_bytes(), &msg)?;
    verify_ed25519_signature(ix_sysvar, &session.consumer.to_bytes(), &msg)?;
    Ok(())
}

/// Move `amount` lamports out of a program-owned PDA (e.g. the session escrow)
/// into `dest`. Both accounts must be owned by this program / writable.
pub fn pda_transfer_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 { return Ok(()); }
    let mut from_l = from.try_borrow_mut_lamports()?;
    let mut to_l = to.try_borrow_mut_lamports()?;
    **from_l = from_l.checked_sub(amount).ok_or(SolMeshError::MathOverflow)?;
    **to_l = to_l.checked_add(amount).ok_or(SolMeshError::MathOverflow)?;
    Ok(())
}

pub fn fee_for(payout: u64, fee_bps: u16) -> Result<u64> {
    (payout as u128)
        .checked_mul(fee_bps as u128)
        .and_then(|v| v.checked_div(crate::constants::BPS_DENOMINATOR as u128))
        .map(|v| v as u64)
        .ok_or(error!(SolMeshError::MathOverflow))
}

/// Reputation delta for a clean settlement, scaled by units consumed.
pub fn reputation_reward(units: u64) -> u32 {
    use crate::constants::*;
    let bonus = (units / REP_UNIT_SCALE).min(REP_MAX_BONUS as u64) as u32;
    REP_BASE_REWARD + bonus
}
