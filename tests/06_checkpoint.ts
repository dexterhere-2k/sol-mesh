import { assert } from "chai";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { setup, ensureConfig, newSession, MPL_CORE } from "./helpers";
import { signState, StateUpdate } from "../client/src/state";

describe("06 checkpoint settlement (M5)", () => {
  const { sdk, connection } = setup();
  before(async () => ensureConfig(sdk, connection));

  it("checkpoints accumulate, final settle reconciles without double-paying", async () => {
    const { provider, consumer, asset, nodePda, session } = await newSession(sdk, connection, { deposit: 2 });

    const cosign = (state: StateUpdate) => ({
      providerSig: signState(provider.secretKey, state),
      consumerSig: signState(consumer.secretKey, state),
    });
    const base = {
      payer: provider, node: nodePda, asset: asset.publicKey,
      provider: provider.publicKey, consumer: consumer.publicKey, session, mplCore: MPL_CORE,
    };

    // Two checkpoints (cumulative owed): 0.3 SOL, then 0.7 SOL.
    let owed = 300_000_000n;
    let state: StateUpdate = { session, nonce: 1n, owedToProvider: owed, unitsConsumed: 1000n, timestamp: 1n };
    await sdk.settle({ ...base, state, ...cosign(state), checkpoint: true });
    let s = await sdk.fetchSession(session);
    assert.equal(s.settledToProvider.toString(), "300000000");
    assert.equal(s.lastNonce.toNumber(), 1);
    assert.equal(Object.keys(s.status)[0], "open", "checkpoint must NOT close the session");

    owed = 700_000_000n;
    state = { session, nonce: 2n, owedToProvider: owed, unitsConsumed: 2500n, timestamp: 2n };
    await sdk.settle({ ...base, state, ...cosign(state), checkpoint: true });
    s = await sdk.fetchSession(session);
    assert.equal(s.settledToProvider.toString(), "700000000");

    // Final settle at cumulative 1.0 SOL — must pay only the incremental 0.3 SOL.
    const provBefore = await connection.getBalance(provider.publicKey);
    state = { session, nonce: 3n, owedToProvider: 1_000_000_000n, unitsConsumed: 4000n, timestamp: 3n };
    await sdk.settle({ ...base, state, ...cosign(state) });
    const provAfter = await connection.getBalance(provider.publicKey);

    s = await sdk.fetchSession(session);
    assert.equal(Object.keys(s.status)[0], "settled");
    assert.equal(s.settledToProvider.toString(), "1000000000");
    // provider received ~0.3 SOL (minus fee) on the final step, not the full 1.0 SOL again.
    const delta = provAfter - provBefore;
    assert.isBelow(delta, 0.31 * LAMPORTS_PER_SOL, "must not double-pay prior checkpoints");
  });

  it("rejects a stale nonce on checkpoint", async () => {
    const { provider, consumer, asset, nodePda, session } = await newSession(sdk, connection, { deposit: 1 });
    const base = { payer: provider, node: nodePda, asset: asset.publicKey, provider: provider.publicKey, consumer: consumer.publicKey, session, mplCore: MPL_CORE };
    const s1: StateUpdate = { session, nonce: 2n, owedToProvider: 100n, unitsConsumed: 1n, timestamp: 1n };
    await sdk.settle({ ...base, state: s1, providerSig: signState(provider.secretKey, s1), consumerSig: signState(consumer.secretKey, s1), checkpoint: true });
    const stale: StateUpdate = { session, nonce: 1n, owedToProvider: 200n, unitsConsumed: 2n, timestamp: 2n };
    try {
      await sdk.settle({ ...base, state: stale, providerSig: signState(provider.secretKey, stale), consumerSig: signState(consumer.secretKey, stale), checkpoint: true });
      assert.fail("stale nonce must be rejected");
    } catch (e: any) {
      assert.match(e.toString(), /StaleNonce|0x/);
    }
  });
});
