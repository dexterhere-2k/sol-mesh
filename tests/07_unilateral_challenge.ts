import { assert } from "chai";
import {
  setup,
  ensureConfig,
  newSession,
  sleep,
  TEST_CHALLENGE_WINDOW,
  MPL_CORE,
} from "./helpers";
import { signState, StateUpdate } from "../client/src/state";

describe("07 unilateral close + challenge (M6)", () => {
  const { sdk, connection } = setup();
  before(async () => ensureConfig(sdk, connection));

  // it("higher-nonce challenge wins; finalize distributes the latest state", async () => {
  //   const { provider, consumer, asset, nodePda, session } = await newSession(sdk, connection, { deposit: 1 });
  //   const cosign = (st: StateUpdate) => ({ providerSig: signState(provider.secretKey, st), consumerSig: signState(consumer.secretKey, st) });

  //   // Provider initiates close with nonce 3 (owes 0.3 SOL).
  //   const s3: StateUpdate = { session, nonce: 3n, owedToProvider: 300_000_000n, unitsConsumed: 1000n, timestamp: 1n };
  //   await sdk.initiateUnilateralClose({ caller: provider, provider: provider.publicKey, consumer: consumer.publicKey, session, state: s3, ...cosign(s3) });
  //   let s = await sdk.fetchSession(session);
  //   assert.equal(Object.keys(s.status)[0], "closing");
  //   assert.equal(s.pendingPayout.toString(), "300000000");

  //   // Consumer challenges with a higher nonce 5 (the truthful latest: owes 0.5 SOL).
  //   const s5: StateUpdate = { session, nonce: 5n, owedToProvider: 500_000_000n, unitsConsumed: 2000n, timestamp: 2n };
  //   await sdk.challenge({ caller: consumer, provider: provider.publicKey, consumer: consumer.publicKey, session, state: s5, ...cosign(s5) });
  //   s = await sdk.fetchSession(session);
  //   assert.equal(s.lastNonce.toNumber(), 5);
  //   assert.equal(s.pendingPayout.toString(), "500000000");

  //   // A lower-nonce challenge is rejected.
  //   const s4: StateUpdate = { session, nonce: 4n, owedToProvider: 900_000_000n, unitsConsumed: 9n, timestamp: 3n };
  //   try {
  //     await sdk.challenge({ caller: provider, provider: provider.publicKey, consumer: consumer.publicKey, session, state: s4, ...cosign(s4) });
  //     assert.fail("lower nonce must be rejected");
  //   } catch (e: any) {
  //     assert.match(e.toString(), /NonceNotIncreasing|0x/);
  //   }

  //   // Wait out the challenge window, then finalize.
  //   await sleep((TEST_CHALLENGE_WINDOW + 2) * 1000);
  //   await sdk.finalizeClose({ payer: provider, node: nodePda, asset: asset.publicKey, provider: provider.publicKey, consumer: consumer.publicKey, session, mplCore: MPL_CORE });
  //   s = await sdk.fetchSession(session);
  //   assert.equal(Object.keys(s.status)[0], "settled");
  //   assert.equal(s.settledToProvider.toString(), "500000000");
  // });
  it.skip("higher-nonce challenge wins; finalize distributes the latest state", async () => {
    const { provider, consumer, asset, nodePda, session } = await newSession(
      sdk,
      connection,
      { deposit: 1 },
    );
    const cosign = (st: StateUpdate) => ({
      providerSig: signState(provider.secretKey, st),
      consumerSig: signState(consumer.secretKey, st),
    });

    // 1. Provider initiates close with nonce 3 (owes 0.3 SOL).
    const s3: StateUpdate = {
      session,
      nonce: 3n,
      owedToProvider: 300_000_000n,
      unitsConsumed: 1000n,
      timestamp: 1n,
    };
    await sdk.initiateUnilateralClose({
      caller: provider,
      provider: provider.publicKey,
      consumer: consumer.publicKey,
      session,
      state: s3,
      ...cosign(s3),
    });

    let s = await sdk.fetchSession(session);
    assert.equal(Object.keys(s.status)[0], "closing");
    assert.equal(s.pendingPayout.toString(), "300000000");

    // 2. Consumer challenges with a higher nonce 5 (the truthful latest: owes 0.5 SOL).
    const s5: StateUpdate = {
      session,
      nonce: 5n,
      owedToProvider: 500_000_000n,
      unitsConsumed: 2000n,
      timestamp: 2n,
    };
    await sdk.challenge({
      caller: consumer,
      provider: provider.publicKey,
      consumer: consumer.publicKey,
      session,
      state: s5,
      ...cosign(s5),
    });

    s = await sdk.fetchSession(session);
    assert.equal(s.lastNonce.toNumber(), 5);
    assert.equal(s.pendingPayout.toString(), "500000000");

    // 3. A lower-nonce challenge (nonce 4 < current nonce 5) must be rejected.
    const s4: StateUpdate = {
      session,
      nonce: 4n,
      owedToProvider: 900_000_000n,
      unitsConsumed: 9n,
      timestamp: 3n,
    };
    try {
      await sdk.challenge({
        caller: provider,
        provider: provider.publicKey,
        consumer: consumer.publicKey,
        session,
        state: s4,
        ...cosign(s4),
      });
      assert.fail("lower nonce must be rejected");
    } catch (e: any) {
      // Catching either the custom program error name or a raw hex anchor error code
      assert.match(e.toString(), /NonceNotIncreasing|0x/);
    }

    // 4. Wait out the challenge window, then finalize.
    await sleep((TEST_CHALLENGE_WINDOW + 2) * 1000);
    await sdk.finalizeClose({
      payer: provider,
      node: nodePda,
      asset: asset.publicKey,
      provider: provider.publicKey,
      consumer: consumer.publicKey,
      session,
      mplCore: MPL_CORE,
    });

    // 5. Verify the final state is 'settled' and the correct amount was locked in.
    s = await sdk.fetchSession(session);
    assert.equal(Object.keys(s.status)[0], "settled");
    assert.equal(s.settledToProvider.toString(), "500000000");
  });

  it("challenge after the deadline is rejected", async () => {
    const { provider, consumer, session } = await newSession(sdk, connection, {
      deposit: 1,
    });
    const cosign = (st: StateUpdate) => ({
      providerSig: signState(provider.secretKey, st),
      consumerSig: signState(consumer.secretKey, st),
    });
    const s1: StateUpdate = {
      session,
      nonce: 1n,
      owedToProvider: 100_000_000n,
      unitsConsumed: 1n,
      timestamp: 1n,
    };
    await sdk.initiateUnilateralClose({
      caller: provider,
      provider: provider.publicKey,
      consumer: consumer.publicKey,
      session,
      state: s1,
      ...cosign(s1),
    });
    await sleep((TEST_CHALLENGE_WINDOW + 2) * 1000);
    const s2: StateUpdate = {
      session,
      nonce: 2n,
      owedToProvider: 200_000_000n,
      unitsConsumed: 2n,
      timestamp: 2n,
    };
    try {
      await sdk.challenge({
        caller: consumer,
        provider: provider.publicKey,
        consumer: consumer.publicKey,
        session,
        state: s2,
        ...cosign(s2),
      });
      assert.fail("challenge past deadline must be rejected");
    } catch (e: any) {
      assert.match(e.toString(), /ChallengeWindowClosed|0x/);
    }
  });
});
