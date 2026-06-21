import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { setup, fundedKeypair, ensureConfig, MPL_CORE } from "./helpers";
import { signState, StateUpdate } from "../client/src/state";

describe("05 settle happy path", () => {
  const { sdk, connection } = setup();
  before(async () => ensureConfig(sdk, connection));

  it("register -> open -> settle splits funds and bumps reputation", async () => {
    const provider = await fundedKeypair(connection);
    const consumer = await fundedKeypair(connection);
    const asset = Keypair.generate();

    await sdk.registerNode(provider, asset, { name: "node-1", uri: "https://x/y.json", capacity: 1000, geo: "us-east", initReputation: 0 }, MPL_CORE);
    const nodePda = sdk.nodePda(asset.publicKey);

    const seed = new BN(Date.now());
    const deposit = new BN(1_000_000_000); // 1 SOL
    await sdk.openSession(consumer, nodePda, seed, deposit, 3600, new BN(10));
    const sessionPda = sdk.sessionPda(nodePda, consumer.publicKey, seed);

    // Off-chain: exchange a final co-signed state where 0.6 SOL is owed.
    const state: StateUpdate = {
      session: sessionPda,
      nonce: 7n,
      owedToProvider: 600_000_000n,
      unitsConsumed: 5000n,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    };
    const providerSig = signState(provider.secretKey, state);
    const consumerSig = signState(consumer.secretKey, state);

    const before = await connection.getBalance(provider.publicKey);
    await sdk.settle({
      payer: provider, node: nodePda, asset: asset.publicKey,
      provider: provider.publicKey, consumer: consumer.publicKey, session: sessionPda,
      mplCore: MPL_CORE, state, providerSig, consumerSig,
    });
    const after = await connection.getBalance(provider.publicKey);

    const node = await sdk.fetchNode(nodePda);
    assert.isAbove(node.reputation, 0, "reputation must increase");
    assert.isAbove(after, before, "provider must be paid");

    const session = await sdk.fetchSession(sessionPda);
    assert.equal(Object.keys(session.status)[0], "settled");
  });
});
