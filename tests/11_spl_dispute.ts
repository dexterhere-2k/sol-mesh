import { assert } from "chai";
import { Keypair, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { setup, ensureConfig, fundedKeypair, sleep, TEST_CHALLENGE_WINDOW, MPL_CORE } from "./helpers";
import { signState, StateUpdate } from "../client/src/state";

// M8 dispute path: exercises the SPL/USDC variant of initiate / challenge /
// finalize_close_spl. initiate + challenge are fund-agnostic (reused from the
// SOL path); only the terminal payout ix is SPL-specific.
describe("11 SPL/USDC dispute path (M8)", () => {
  const { sdk, connection, provider: anchorProvider } = setup();
  before(async () => ensureConfig(sdk, connection));

  it("initiate -> challenge -> finalize_close_spl splits tokens correctly", async () => {
    const payer = (anchorProvider as any).wallet.payer as Keypair;
    const provider = await fundedKeypair(connection);
    const consumer = await fundedKeypair(connection);
    const asset = Keypair.generate();

    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    const consumerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, consumer.publicKey);
    const providerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, provider.publicKey);
    await mintTo(connection, payer, mint, consumerAta.address, payer, 1_000_000);

    const feeVault = sdk.feeVaultPda();
    const feeAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, feeVault, true);

    await sdk.registerNode(provider, asset, { name: "spl-dispute", uri: "https://x/y.json", capacity: 1000, geo: "us-east" }, MPL_CORE);
    const node = sdk.nodePda(asset.publicKey);

    const seed = new BN(Date.now() + 7);
    await sdk.openSessionSpl({
      consumer, node, seed, mint, amount: new BN(1_000_000), durationSecs: 3600, ratePerUnit: new BN(1),
      consumerToken: consumerAta.address, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    });
    const session = sdk.sessionPda(node, consumer.publicKey, seed);
    const vaultAuthority = sdk.vaultAuthority(session);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    assert.equal(Number((await getAccount(connection, vaultToken)).amount), 1_000_000);

    // Provider initiates close with nonce 2 (owes 200_000 units).
    const s2: StateUpdate = { session, nonce: 2n, owedToProvider: 200_000n, unitsConsumed: 800n, timestamp: 1n };
    await sdk.initiateUnilateralClose({
      caller: provider, provider: provider.publicKey, consumer: consumer.publicKey,
      session, state: s2,
      providerSig: signState(provider.secretKey, s2), consumerSig: signState(consumer.secretKey, s2),
    });
    let s = await sdk.fetchSession(session);
    assert.equal(Object.keys(s.status)[0], "closing");
    assert.equal(s.pendingPayout.toString(), "200000");

    // Consumer challenges with a higher nonce 4 (truthful: owes 400_000).
    const s4: StateUpdate = { session, nonce: 4n, owedToProvider: 400_000n, unitsConsumed: 1500n, timestamp: 2n };
    await sdk.challenge({
      caller: consumer, provider: provider.publicKey, consumer: consumer.publicKey,
      session, state: s4,
      providerSig: signState(provider.secretKey, s4), consumerSig: signState(consumer.secretKey, s4),
    });
    s = await sdk.fetchSession(session);
    assert.equal(s.lastNonce.toNumber(), 4);
    assert.equal(s.pendingPayout.toString(), "400000");

    // Wait out the challenge window, then finalize_close_spl.
    await sleep((TEST_CHALLENGE_WINDOW + 2) * 1000);
    await sdk.program.methods.finalizeCloseSpl()
      .accounts({
        config: sdk.configPda(), node, session,
        provider: provider.publicKey, consumer: consumer.publicKey, asset: asset.publicKey,
        vaultAuthority, vaultToken,
        providerToken: providerAta.address, consumerToken: consumerAta.address, feeToken: feeAta.address,
        payer: provider.publicKey, mplCoreProgram: MPL_CORE,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([provider])
      .rpc();

    const fee = Math.floor((400_000 * 50) / 10_000);
    assert.equal(Number((await getAccount(connection, providerAta.address)).amount), 400_000 - fee);
    assert.equal(Number((await getAccount(connection, feeAta.address)).amount), fee);
    assert.equal(Number((await getAccount(connection, consumerAta.address)).amount), 1_000_000 - 400_000);

    s = await sdk.fetchSession(session);
    assert.equal(Object.keys(s.status)[0], "settled");
    assert.equal(s.settledToProvider.toString(), "400000");
  });

  it("cancel_session_spl refunds full deposit when no usage yet", async () => {
    const payer = (anchorProvider as any).wallet.payer as Keypair;
    const provider = await fundedKeypair(connection);
    const consumer = await fundedKeypair(connection);
    const asset = Keypair.generate();

    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    const consumerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, consumer.publicKey);
    await mintTo(connection, payer, mint, consumerAta.address, payer, 1_000_000);

    await sdk.registerNode(provider, asset, { name: "spl-cancel", uri: "https://x/y.json", capacity: 1000, geo: "us-east" }, MPL_CORE);
    const node = sdk.nodePda(asset.publicKey);

    const seed = new BN(Date.now() + 17);
    await sdk.openSessionSpl({
      consumer, node, seed, mint, amount: new BN(1_000_000), durationSecs: 3600, ratePerUnit: new BN(1),
      consumerToken: consumerAta.address, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    });
    const session = sdk.sessionPda(node, consumer.publicKey, seed);
    const vaultAuthority = sdk.vaultAuthority(session);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

    await sdk.program.methods.cancelSessionSpl()
      .accounts({
        config: sdk.configPda(), session, consumer: consumer.publicKey,
        vaultAuthority, vaultToken, consumerToken: consumerAta.address,
        signer: consumer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([consumer])
      .rpc();

    assert.equal(Number((await getAccount(connection, consumerAta.address)).amount), 1_000_000);
    const s = await sdk.fetchSession(session);
    assert.equal(Object.keys(s.status)[0], "cancelled");
  });
});
