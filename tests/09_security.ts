import { assert } from "chai";
import { Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import BN from "bn.js";
import { setup, fundedKeypair, ensureConfig, MPL_CORE, sleep, TEST_CHALLENGE_WINDOW } from "./helpers";
import { signState, StateUpdate, serializeState, cosignIxs, ed25519VerifyIx } from "../client/src/state";
import nacl from "tweetnacl";

describe("09 security", () => {
  const { sdk, connection, program } = setup();
  before(async () => ensureConfig(sdk, connection));

  async function freshSession() {
    const provider = await fundedKeypair(connection);
    const consumer = await fundedKeypair(connection);
    const asset = Keypair.generate();
    await sdk.registerNode(provider, asset, { name: "n", uri: "https://x/y.json", capacity: 1000, geo: "eu", initReputation: 0 }, MPL_CORE);
    const nodePda = sdk.nodePda(asset.publicKey);
    const seed = new BN(Date.now() + Math.floor(Math.random() * 1e6));
    await sdk.openSession(consumer, nodePda, seed, new BN(1_000_000_000), 3600, new BN(1));
    const session = sdk.sessionPda(nodePda, consumer.publicKey, seed);
    return { provider, consumer, asset, nodePda, session };
  }

  function makeState(session: PublicKey, nonce: bigint, owed = 100n, units = 1n): StateUpdate {
    return { session, nonce, owedToProvider: owed, unitsConsumed: units, timestamp: 1n };
  }

  /** Send a settle tx with caller-supplied extra instructions prepended (for tampering tests). */
  async function settleWithExtra(
    session: { provider: Keypair; consumer: Keypair; nodePda: PublicKey; asset: Keypair; session: PublicKey },
    state: StateUpdate,
    providerSig: Uint8Array,
    consumerSig: Uint8Array,
    extraIxs: TransactionInstruction[] = [],
    swapProviderConsumerIxs = false
  ) {
    const { provider, consumer, nodePda, asset, session: sessionPda } = session;
    const settleIx = await program.methods
      .settleSession({
        domain: Array.from(Buffer.from("SOLMESH1", "utf8")),
        session: Array.from(state.session.toBytes()),
        nonce: new BN(state.nonce.toString()),
        owedToProvider: new BN(state.owedToProvider.toString()),
        unitsConsumed: new BN(state.unitsConsumed.toString()),
        timestamp: new BN(state.timestamp.toString()),
      })
      .accounts({
        config: sdk.configPda(), node: nodePda, session: sessionPda,
        provider: provider.publicKey, consumer: consumer.publicKey, asset: asset.publicKey,
        feeVault: sdk.feeVaultPda(), payer: provider.publicKey,
        mplCoreProgram: MPL_CORE, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: PublicKey.default,
      })
      .signers([provider])
      .instruction();

    const ixs = swapProviderConsumerIxs
      ? [
          ed25519VerifyIx(consumer.publicKey, serializeState(state), consumerSig),
          ed25519VerifyIx(provider.publicKey, serializeState(state), providerSig),
        ]
      : [
          ed25519VerifyIx(provider.publicKey, serializeState(state), providerSig),
          ed25519VerifyIx(consumer.publicKey, serializeState(state), consumerSig),
        ];

    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    if (extraIxs.length > 0) {
      tx.add(...extraIxs);
    }
    tx.add(...ixs).add(settleIx);
    return sendAndConfirmTransaction(connection, tx, [provider]);
  }

  it("replay: re-settling an already-settled state is rejected", async () => {
    const ctx = await freshSession();
    const state: StateUpdate = { session: ctx.session, nonce: 1n, owedToProvider: 100n, unitsConsumed: 1n, timestamp: 1n };
    const ps = signState(ctx.provider.secretKey, state);
    const cs = signState(ctx.consumer.secretKey, state);
    await settleWithExtra(ctx, state, ps, cs); // first settle succeeds
    // Second attempt with the same nonce must fail (StaleNonce / SessionNotOpen).
    try {
      await settleWithExtra(ctx, state, ps, cs);
      assert.fail("replay must fail");
    } catch (e: any) {
      assert.match(e.toString(), /StaleNonce|SessionNotOpen|0x|custom program error/);
    }
  });

  it("stale nonce (<= last_nonce) is rejected on settle", async () => {
    const ctx = await freshSession();
    const s1: StateUpdate = { session: ctx.session, nonce: 5n, owedToProvider: 100n, unitsConsumed: 1n, timestamp: 1n };
    const s0: StateUpdate = { session: ctx.session, nonce: 4n, owedToProvider: 50n, unitsConsumed: 1n, timestamp: 1n };
    await settleWithExtra(ctx, s1, signState(ctx.provider.secretKey, s1), signState(ctx.consumer.secretKey, s1));
    try {
      await settleWithExtra(ctx, s0, signState(ctx.provider.secretKey, s0), signState(ctx.consumer.secretKey, s0));
      assert.fail("stale nonce must fail");
    } catch (e: any) {
      assert.match(e.toString(), /StaleNonce|0x|custom program error/);
    }
  });

  it("owed > deposited is rejected", async () => {
    const ctx = await freshSession();
    const state: StateUpdate = { session: ctx.session, nonce: 1n, owedToProvider: 9_000_000_000n, unitsConsumed: 1n, timestamp: 1n };
    const ps = signState(ctx.provider.secretKey, state);
    const cs = signState(ctx.consumer.secretKey, state);
    try {
      await settleWithExtra(ctx, state, ps, cs);
      assert.fail("over-deposit must fail");
    } catch (e: any) {
      assert.match(e.toString(), /OwedExceedsDeposit|0x|custom program error/);
    }
  });

  it("ed25519 ix referencing a different instruction index is rejected", async () => {
    const ctx = await freshSession();
    const state: StateUpdate = { session: ctx.session, nonce: 1n, owedToProvider: 100n, unitsConsumed: 1n, timestamp: 1n };
    const ps = signState(ctx.provider.secretKey, state);
    const cs = signState(ctx.consumer.secretKey, state);
    // Build a hand-crafted ed25519 ix where message_data_instruction_index points
    // to a different ix (0) rather than self (u16::MAX). The precompile will still
    // verify the math, but our introspection must reject it (Ed25519CrossIndex).
    const msg = serializeState(state);
    const pk = ctx.provider.publicKey.toBytes();
    const sig = ps;
    const HEADER = 2, OFFSETS = 14;
    const pkOffset = HEADER + OFFSETS;
    const sigOffset = pkOffset + 32;
    const msgOffset = sigOffset + 64;
    const tampered = Buffer.alloc(msgOffset + msg.length);
    tampered.writeUInt8(1, 0);
    tampered.writeUInt8(0, 1);
    let o = HEADER;
    const w16 = (v: number) => { tampered.writeUInt16LE(v, o); o += 2; };
    w16(sigOffset); w16(0xffff);              // signature + ix index = self
    w16(pkOffset);  w16(0xffff);              // pubkey    + ix index = self
    w16(msgOffset); w16(msg.length); w16(0);  // message ix index = 0 (WRONG, must be 0xffff)
    Buffer.from(pk).copy(tampered, pkOffset);
    Buffer.from(sig).copy(tampered, sigOffset);
    Buffer.from(msg).copy(tampered, msgOffset);
    const tamperedIx = new TransactionInstruction({ programId: new PublicKey("Ed25519SigVerify111111111111111111111111111"), data: tampered, keys: [] });

    const settleIx = await program.methods
      .settleSession({
        domain: Array.from(Buffer.from("SOLMESH1", "utf8")),
        session: Array.from(state.session.toBytes()),
        nonce: new BN(state.nonce.toString()),
        owedToProvider: new BN(state.owedToProvider.toString()),
        unitsConsumed: new BN(state.unitsConsumed.toString()),
        timestamp: new BN(state.timestamp.toString()),
      })
      .accounts({
        config: sdk.configPda(), node: ctx.nodePda, session: ctx.session,
        provider: ctx.provider.publicKey, consumer: ctx.consumer.publicKey, asset: ctx.asset.publicKey,
        feeVault: sdk.feeVaultPda(), payer: ctx.provider.publicKey,
        mplCoreProgram: MPL_CORE, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: PublicKey.default,
      })
      .signers([ctx.provider])
      .instruction();

    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(tamperedIx)                                                                                  // tampered (cross-ix)
      .add(ed25519VerifyIx(ctx.consumer.publicKey, serializeState(state), cs))                          // consumer
      .add(settleIx);
    try {
      await sendAndConfirmTransaction(connection, tx, [ctx.provider]);
      assert.fail("cross-ix ed25519 reference must fail");
    } catch (e: any) {
      assert.match(e.toString(), /Ed25519CrossIndex|0x|custom program error/);
    }
  });

  it("provider cannot forge reputation by writing the Node account directly", async () => {
    const ctx = await freshSession();
    // The Node account is owned by the program; raw lamport/owner mutation from
    // a client is impossible. We assert the account is program-owned, which is
    // what enforces "reputation is only mutable by the program PDA".
    const info = await connection.getAccountInfo(ctx.nodePda);
    assert.ok(info, "node account exists");
    assert.ok(info!.owner.equals(program.programId), "Node account must be program-owned (provider cannot write it directly)");
    // And the source of truth for reputation lives on the Core NFT, which has
    // UpdateDelegate authority == node PDA (also program-controlled). Provider's
    // own wallet cannot mutate the plugin: a direct `updatePlugin` from provider
    // would fail at the Core program because the authority doesn't match.
  });
});
