import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { serializeState, signState, verifyStateSig, STATE_LEN } from "../client/src/state";
import { GOLDEN_STATE_HEX } from "./helpers";

const U16_MAX = 0xffff;

/** Build the ed25519 precompile instruction data the same way @solana/web3.js does
 *  (self-contained: pubkey, signature, message appended after the 16-byte header,
 *  all instruction indices = u16::MAX). This is the EXACT layout programs/solmesh/
 *  src/crypto/ed25519.rs parses — assert it explicitly (SPEC §12, gap §1.2). */
function buildEd25519Data(pubkey: Buffer, signature: Buffer, message: Buffer): Buffer {
  const HEADER = 2, OFFSETS = 14;
  const pkOffset = HEADER + OFFSETS;          // 16
  const sigOffset = pkOffset + 32;            // 48
  const msgOffset = sigOffset + 64;           // 112
  const data = Buffer.alloc(msgOffset + message.length);
  data.writeUInt8(1, 0);                      // numSignatures
  data.writeUInt8(0, 1);                      // padding
  let o = HEADER;
  const w16 = (v: number) => { data.writeUInt16LE(v, o); o += 2; };
  w16(sigOffset); w16(U16_MAX);               // signature + ix index
  w16(pkOffset);  w16(U16_MAX);               // pubkey + ix index
  w16(msgOffset); w16(message.length); w16(U16_MAX); // message off/size/ix index
  pubkey.copy(data, pkOffset);
  signature.copy(data, sigOffset);
  message.copy(data, msgOffset);
  return data;
}

describe("04 state channel (off-chain)", () => {
  it("matches Rust golden bytes (Rust<->TS borsh parity)", () => {
    const session = new PublicKey(Buffer.alloc(32, 7));
    const bytes = serializeState({ session, nonce: 3n, owedToProvider: 1000n, unitsConsumed: 42n, timestamp: 1700000000n });
    assert.equal(bytes.length, STATE_LEN);
    assert.equal(bytes.toString("hex"), GOLDEN_STATE_HEX);
  });

  it("co-sign + verify roundtrip", () => {
    const provider = Keypair.generate();
    const consumer = Keypair.generate();
    const session = Keypair.generate().publicKey;
    const state = { session, nonce: 5n, owedToProvider: 500_000n, unitsConsumed: 1200n, timestamp: 1700001234n };
    const ps = signState(provider.secretKey, state);
    const cs = signState(consumer.secretKey, state);
    assert.isTrue(verifyStateSig(provider.publicKey, state, ps));
    assert.isTrue(verifyStateSig(consumer.publicKey, state, cs));
    assert.isFalse(verifyStateSig(consumer.publicKey, state, ps)); // wrong signer
  });

  it("ed25519 instruction byte layout: self-contained, u16::MAX sentinels (M3)", () => {
    const kp = Keypair.generate();
    const session = Keypair.generate().publicKey;
    const msg = serializeState({ session, nonce: 1n, owedToProvider: 1n, unitsConsumed: 1n, timestamp: 1n });
    const sig = Buffer.from(nacl.sign.detached(msg, kp.secretKey));
    const pk = Buffer.from(kp.publicKey.toBytes());
    const data = buildEd25519Data(pk, sig, msg);

    // header
    assert.equal(data.readUInt8(0), 1, "numSignatures");
    // offsets the program reads
    const sigOffset = data.readUInt16LE(2);
    const sigIx = data.readUInt16LE(4);
    const pkOffset = data.readUInt16LE(6);
    const pkIx = data.readUInt16LE(8);
    const msgOffset = data.readUInt16LE(10);
    const msgSize = data.readUInt16LE(12);
    const msgIx = data.readUInt16LE(14);
    // the critical invariant ed25519.rs depends on:
    assert.equal(sigIx, U16_MAX); assert.equal(pkIx, U16_MAX); assert.equal(msgIx, U16_MAX);
    // and the extracted slices must equal the originals
    assert.deepEqual(data.subarray(pkOffset, pkOffset + 32), pk);
    assert.equal(msgSize, msg.length);
    assert.deepEqual(data.subarray(msgOffset, msgOffset + msgSize), msg);
    assert.deepEqual(data.subarray(sigOffset, sigOffset + 64), sig);
  });
});
