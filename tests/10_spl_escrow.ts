import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { setup, ensureConfig, fundedKeypair, MPL_CORE } from "./helpers";
import { signState, StateUpdate } from "../client/src/state";

// M8: USDC-style escrow. Mirrors 05 but with an SPL mint.
describe("10 SPL/USDC escrow happy path (M8)", () => {
  const { sdk, connection, provider: anchorProvider } = setup();
  before(async () => ensureConfig(sdk, connection));

  it("open_session_spl -> settle_session_spl splits tokens + bumps reputation", async () => {
    const payer = (anchorProvider as any).wallet.payer as Keypair; // funded by the test validator
    const provider = await fundedKeypair(connection);
    const consumer = await fundedKeypair(connection);
    const asset = Keypair.generate();

    // 6-decimal mint (USDC-like).
    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    const consumerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, consumer.publicKey);
    const providerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, provider.publicKey);
    await mintTo(connection, payer, mint, consumerAta.address, payer, 1_000_000); // 1.0 token

    // Fee vault token account: ATA owned by the fee_vault PDA.
    const feeVault = sdk.feeVaultPda();
    const feeAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, feeVault, true);

    await sdk.registerNode(provider, asset, { name: "spl-node", uri: "https://x/y.json", capacity: 1000, geo: "us-east" }, MPL_CORE);
    const node = sdk.nodePda(asset.publicKey);

    const seed = new BN(Date.now());
    await sdk.openSessionSpl({
      consumer, node, seed, mint, amount: new BN(1_000_000), durationSecs: 3600, ratePerUnit: new BN(1),
      consumerToken: consumerAta.address, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    });
    const session = sdk.sessionPda(node, consumer.publicKey, seed);
    const vaultAuthority = sdk.vaultAuthority(session);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

    assert.equal(Number((await getAccount(connection, vaultToken)).amount), 1_000_000, "vault holds the deposit");

    // Final co-signed state: 0.6 token owed to provider.
    const state: StateUpdate = { session, nonce: 4n, owedToProvider: 600_000n, unitsConsumed: 3000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
    await sdk.settleSpl({
      payer: provider, node, asset: asset.publicKey, provider: provider.publicKey, consumer: consumer.publicKey, session,
      mint, mplCore: MPL_CORE, state,
      providerSig: signState(provider.secretKey, state), consumerSig: signState(consumer.secretKey, state),
      vaultToken, providerToken: providerAta.address, consumerToken: consumerAta.address, feeToken: feeAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

    const fee = Math.floor((600_000 * 50) / 10_000); // 0.5%
    assert.equal(Number((await getAccount(connection, providerAta.address)).amount), 600_000 - fee);
    assert.equal(Number((await getAccount(connection, feeAta.address)).amount), fee);
    assert.equal(Number((await getAccount(connection, consumerAta.address)).amount), 1_000_000 - 600_000); // refund
    const n = await sdk.fetchNode(node);
    assert.isAbove(n.reputation, 0);
    assert.equal(Object.keys((await sdk.fetchSession(session)).status)[0], "settled");
  });
});
