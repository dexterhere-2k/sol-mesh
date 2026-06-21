import { assert } from "chai";
import { setup, ensureConfig, newSession, MPL_CORE } from "./helpers";
import { signState, StateUpdate } from "../client/src/state";

describe("08 expire-with-checkpoint + cancel-after-usage (M2 edge cases)", () => {
  const { sdk, connection } = setup();
  before(async () => ensureConfig(sdk, connection));

  it("expire after a checkpoint: provider keeps checkpointed amount, consumer gets the rest", async () => {
    const { provider, consumer, asset, nodePda, session } = await newSession(sdk, connection, { deposit: 2, durationSecs: 2 });
    const st: StateUpdate = { session, nonce: 1n, owedToProvider: 500_000_000n, unitsConsumed: 800n, timestamp: 1n };
    await sdk.settle({
      payer: provider, node: nodePda, asset: asset.publicKey, provider: provider.publicKey,
      consumer: consumer.publicKey, session, mplCore: MPL_CORE, state: st,
      providerSig: signState(provider.secretKey, st), consumerSig: signState(consumer.secretKey, st), checkpoint: true,
    });
    let s = await sdk.fetchSession(session);
    assert.equal(s.settledToProvider.toString(), "500000000");

    await new Promise((r) => setTimeout(r, 2500)); // wait for expiry
    const cranker = await (await import("./helpers")).fundedKeypair(connection);
    await sdk.expireSession(cranker, session, consumer.publicKey);
    s = await sdk.fetchSession(session);
    assert.equal(Object.keys(s.status)[0], "expired");
    // settled_to_provider stays at the checkpointed 0.5 SOL; remainder went to consumer.
    assert.equal(s.settledToProvider.toString(), "500000000");
  });

  it("cancel after usage has started (nonce > 0) must fail", async () => {
    const { provider, consumer, asset, nodePda, session } = await newSession(sdk, connection, { deposit: 1 });
    const st: StateUpdate = { session, nonce: 1n, owedToProvider: 100_000_000n, unitsConsumed: 50n, timestamp: 1n };
    await sdk.settle({
      payer: provider, node: nodePda, asset: asset.publicKey, provider: provider.publicKey,
      consumer: consumer.publicKey, session, mplCore: MPL_CORE, state: st,
      providerSig: signState(provider.secretKey, st), consumerSig: signState(consumer.secretKey, st), checkpoint: true,
    });
    try {
      await sdk.cancelSession(consumer, session);
      assert.fail("cancel after usage must fail");
    } catch (e: any) {
      assert.match(e.toString(), /SessionHasUsage|0x/);
    }
  });
});
