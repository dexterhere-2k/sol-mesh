import { assert } from "chai";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { setup, ensureConfig, fundedKeypair, MPL_CORE } from "./helpers";

describe("03 open / cancel / expire (SOL escrow)", () => {
  const { sdk, connection } = setup();
  before(async () => ensureConfig(sdk, connection));

  async function registerNode() {
    const provider = await fundedKeypair(connection);
    const asset = Keypair.generate();
    await sdk.registerNode(provider, asset, { name: "n", uri: "https://x/y.json", capacity: 1000, geo: "eu" }, MPL_CORE);
    return { provider, node: sdk.nodePda(asset.publicKey) };
  }

  it("open: locks exactly `amount` lamports into the session PDA", async () => {
    const { node } = await registerNode();
    const consumer = await fundedKeypair(connection);
    const seed = new BN(Date.now());
    const amount = new BN(LAMPORTS_PER_SOL);
    const session = sdk.sessionPda(node, consumer.publicKey, seed);
    const before = await connection.getBalance(session);
    await sdk.openSession(consumer, node, seed, amount, 3600, new BN(10));
    const after = await connection.getBalance(session);
    // session balance = rent + deposit; the deposit portion must equal amount.
    assert.equal(after - before - (await connection.getMinimumBalanceForRentExemption((await connection.getAccountInfo(session))!.data.length)), amount.toNumber());
    const s = await sdk.fetchSession(session);
    assert.equal(s.deposited.toNumber(), amount.toNumber());
    assert.equal(s.lastNonce.toNumber(), 0);
  });

  it("cancel: full refund when no usage (nonce == 0)", async () => {
    const { node } = await registerNode();
    const consumer = await fundedKeypair(connection);
    const seed = new BN(Date.now() + 1);
    await sdk.openSession(consumer, node, seed, new BN(LAMPORTS_PER_SOL), 3600, new BN(1));
    const session = sdk.sessionPda(node, consumer.publicKey, seed);
    const before = await connection.getBalance(consumer.publicKey);
    await sdk.cancelSession(consumer, session);
    const after = await connection.getBalance(consumer.publicKey);
    assert.isAtLeast(after - before, LAMPORTS_PER_SOL - 10_000, "consumer should be refunded the deposit");
    const s = await sdk.fetchSession(session);
    assert.equal(Object.keys(s.status)[0], "cancelled");
  });

  it("expire: refunds unsettled remainder after expiry", async () => {
    const { node } = await registerNode();
    const consumer = await fundedKeypair(connection);
    const seed = new BN(Date.now() + 2);
    // 1 second duration so it expires almost immediately.
    await sdk.openSession(consumer, node, seed, new BN(LAMPORTS_PER_SOL), 1, new BN(1));
    const session = sdk.sessionPda(node, consumer.publicKey, seed);
    await new Promise((r) => setTimeout(r, 2500));
    const cranker = await fundedKeypair(connection);
    await sdk.expireSession(cranker, session, consumer.publicKey);
    const s = await sdk.fetchSession(session);
    assert.equal(Object.keys(s.status)[0], "expired");
  });
});
