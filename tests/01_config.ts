import { assert } from "chai";
import { setup, ensureConfig, ADMIN, MPL_CORE, TEST_CHALLENGE_WINDOW } from "./helpers";

describe("01 config", () => {
  const { sdk, connection } = setup();

  it("initializes the singleton config", async () => {
    await ensureConfig(sdk, connection);
    const cfg = await (sdk.program.account as any).config.fetch(sdk.configPda());
    assert.equal(cfg.feeBps, 50);
    assert.equal(cfg.paused, false);
    assert.equal(cfg.challengeWindowSecs.toNumber(), TEST_CHALLENGE_WINDOW);
    assert.ok(cfg.mplCoreProgram.equals(MPL_CORE));
    assert.ok(cfg.authority.equals(ADMIN.publicKey));
  });

  it("rejects re-initialization / fee > 10%", async () => {
    try {
      await sdk.initializeConfig(ADMIN, 2000, 3600, MPL_CORE);
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.match(e.toString(), /FeeTooHigh|already in use|0x0/);
    }
  });

  it("admin can update fee and pause flag", async () => {
    await sdk.program.methods.updateConfig(75, null)
      .accounts({ config: sdk.configPda(), authority: ADMIN.publicKey }).signers([ADMIN]).rpc();
    let cfg = await (sdk.program.account as any).config.fetch(sdk.configPda());
    assert.equal(cfg.feeBps, 75);
    // restore
    await sdk.program.methods.updateConfig(50, null)
      .accounts({ config: sdk.configPda(), authority: ADMIN.publicKey }).signers([ADMIN]).rpc();
  });
});
