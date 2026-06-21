// Canonical StateUpdate serialization — MUST be byte-identical to the Rust
// `solmesh-state` crate. We build the buffer manually (fixed 72 bytes) so there
// is zero ambiguity. A golden-bytes parity test lives in tests/04_state_channel.ts.

import { PublicKey, Ed25519Program, TransactionInstruction } from "@solana/web3.js";
import nacl from "tweetnacl";
import BN from "bn.js";

export const STATE_DOMAIN = Buffer.from("SOLMESH1", "utf8"); // 8 bytes
export const STATE_LEN = 8 + 32 + 8 + 8 + 8 + 8; // 72

export interface StateUpdate {
  session: PublicKey;
  nonce: bigint;
  owedToProvider: bigint;
  unitsConsumed: bigint;
  timestamp: bigint;
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function i64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return b;
}

/** Deterministic bytes that both parties sign. */
export function serializeState(s: StateUpdate): Buffer {
  return Buffer.concat([
    STATE_DOMAIN,
    s.session.toBuffer(),
    u64le(s.nonce),
    u64le(s.owedToProvider),
    u64le(s.unitsConsumed),
    i64le(s.timestamp),
  ]);
}

/** Anchor passes StateUpdate as an arg; this is the JS object Anchor expects. */
export function toAnchorArg(s: StateUpdate) {
  return {
    domain: Array.from(STATE_DOMAIN),
    session: Array.from(s.session.toBuffer()),
    nonce: new BN(s.nonce.toString()),
    owedToProvider: new BN(s.owedToProvider.toString()),
    unitsConsumed: new BN(s.unitsConsumed.toString()),
    timestamp: new BN(s.timestamp.toString()),
  };
}

export function signState(secretKey: Uint8Array, s: StateUpdate): Uint8Array {
  return nacl.sign.detached(serializeState(s), secretKey);
}

export function verifyStateSig(pubkey: PublicKey, s: StateUpdate, sig: Uint8Array): boolean {
  return nacl.sign.detached.verify(serializeState(s), sig, pubkey.toBytes());
}

/**
 * Build the native Ed25519Program instruction binding (pubkey, message, signature).
 * MUST be added to the transaction BEFORE the settle instruction. The runtime
 * precompile verifies the signature; the program then introspects this ix.
 */
export function ed25519VerifyIx(publicKey: PublicKey, message: Buffer, signature: Uint8Array): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: publicKey.toBytes(),
    message,
    signature,
  });
}

/** Convenience: both parties' ed25519 ixs for one co-signed state. */
export function cosignIxs(
  state: StateUpdate,
  provider: { publicKey: PublicKey; sig: Uint8Array },
  consumer: { publicKey: PublicKey; sig: Uint8Array }
): TransactionInstruction[] {
  const msg = serializeState(state);
  return [
    ed25519VerifyIx(provider.publicKey, msg, provider.sig),
    ed25519VerifyIx(consumer.publicKey, msg, consumer.sig),
  ];
}
