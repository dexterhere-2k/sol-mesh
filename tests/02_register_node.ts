import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import { setup, ensureConfig, fundedKeypair, MPL_CORE } from "./helpers";

describe("02 register node (Metaplex Core)", () => {
  const { sdk, connection } = setup();
  before(async () => ensureConfig(sdk, connection));

  it("mints a Core asset and initializes the Node account", async () => {
    const provider = await fundedKeypair(connection);
    const asset = Keypair.generate();
    await sdk.registerNode(
      provider, asset,
      { name: "edge-node-1", uri: "https://solmesh.test/node1.json", capacity: 2500, geo: "us-east", initReputation: 0 },
      MPL_CORE
    );

    const node = await sdk.fetchNode(sdk.nodePda(asset.publicKey));
    assert.ok(node.asset.equals(asset.publicKey));
    assert.ok(node.provider.equals(provider.publicKey));
    assert.equal(node.capacity.toNumber(), 2500);
    assert.equal(node.geo, "us-east");
    assert.equal(node.reputation, 0);
    assert.equal(node.totalUnits.toNumber(), 0);
    assert.equal(node.active, true);

    // The Core asset account must exist and be owned by the Core program.
    const info = await connection.getAccountInfo(asset.publicKey);
    assert.ok(info, "asset account should exist");
    assert.ok(info!.owner.equals(MPL_CORE), "asset must be owned by Core program");
    // Deeper attribute assertions (capacity/geo/reputation/total_units, UpdateDelegate
    // authority == node PDA) are validated indirectly in 05 when reputation is bumped.
  });

  it("rejects zero capacity", async () => {
    const provider = await fundedKeypair(connection);
    const asset = Keypair.generate();
    try {
      await sdk.registerNode(provider, asset, { name: "bad", uri: "https://x/y.json", capacity: 0, geo: "eu" }, MPL_CORE);
      assert.fail("should reject capacity 0");
    } catch (e: any) {
      assert.match(e.toString(), /AmountZero|0x/);
    }
  });
});
