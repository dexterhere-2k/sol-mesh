/**
 * Full happy-path e2e demo (single process), matching SPEC §13 "Definition of done":
 *   register node -> open session -> exchange 5 co-signed states over the relay -> settle.
 * Run a local validator + `ts-node client/src/relay.ts` first, then:
 *   anchor build && RPC=http://localhost:8899 ts-node client/examples/demo.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import WebSocket from "ws";
import BN from "bn.js";
import { makeSdk, MPL_CORE, RELAY, log } from "./common";
import { StateUpdate, signState, verifyStateSig } from "../src/state";

async function airdrop(sdk: any, kp: Keypair, sol = 5) {
  const sig = await sdk.connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  await sdk.connection.confirmTransaction(sig, "confirmed");
}

(async () => {
  const provider = Keypair.generate();
  const consumer = Keypair.generate();
  const asset = Keypair.generate();

  const providerSdk = makeSdk(provider);
  const consumerSdk = makeSdk(consumer);
  await airdrop(providerSdk, provider);
  await airdrop(consumerSdk, consumer);

  // 1) Register node (3 lamports-cheap Core NFT).
  await providerSdk.registerNode(provider, asset, { name: "demo-node", uri: "https://solmesh.test/n.json", capacity: 1000, geo: "us-east" }, MPL_CORE);
  const node = providerSdk.nodePda(asset.publicKey);
  log("provider", `registered node, asset=${asset.publicKey.toBase58()}`);

  // 2) Open session: lock 1 SOL.
  const seed = new BN(Date.now());
  await consumerSdk.openSession(consumer, node, seed, new BN(LAMPORTS_PER_SOL), 3600, new BN(1));
  const session = consumerSdk.sessionPda(node, consumer.publicKey, seed);
  log("consumer", `opened session ${session.toBase58()} with 1 SOL escrow`);

  // 3) State channel over the relay: provider proposes, consumer co-signs (5 ticks).
  const pWs = new WebSocket(RELAY), cWs = new WebSocket(RELAY);
  const ready = (ws: WebSocket, role: string) => new Promise<void>((res) => ws.on("open", () => { ws.send(JSON.stringify({ type: "join", session: session.toBase58(), role })); res(); }));
  await Promise.all([ready(pWs, "provider"), ready(cWs, "consumer")]);

  let latest: { state: StateUpdate; providerSig: Uint8Array; consumerSig: Uint8Array } | null = null;
  const done = new Promise<void>((resolve) => {
    // Consumer side: verify provider sig, counter-sign, return.
    cWs.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const state: StateUpdate = { session, nonce: BigInt(m.nonce), owedToProvider: BigInt(m.owed), unitsConsumed: BigInt(m.units), timestamp: BigInt(m.ts) };
      if (!verifyStateSig(provider.publicKey, state, Buffer.from(m.providerSig, "hex"))) throw new Error("bad provider sig");
      const consumerSig = signState(consumer.secretKey, state);
      cWs.send(JSON.stringify({ ...m, consumerSig: Buffer.from(consumerSig).toString("hex") }));
    });
    // Provider side: receive fully co-signed state.
    pWs.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const state: StateUpdate = { session, nonce: BigInt(m.nonce), owedToProvider: BigInt(m.owed), unitsConsumed: BigInt(m.units), timestamp: BigInt(m.ts) };
      latest = { state, providerSig: Buffer.from(m.providerSig, "hex"), consumerSig: Buffer.from(m.consumerSig, "hex") };
      log("provider", `tick #${m.nonce} co-signed: owed=${(Number(m.owed) / 1e9).toFixed(2)} SOL (0 on-chain txs)`);
      if (Number(m.nonce) >= 5) resolve();
    });
  });

  let owed = 0n;
  for (let n = 1; n <= 5; n++) {
    owed += 120_000_000n; // +0.12 SOL each tick
    const state: StateUpdate = { session, nonce: BigInt(n), owedToProvider: owed, unitsConsumed: BigInt(n * 250), timestamp: BigInt(Math.floor(Date.now() / 1000)) };
    const providerSig = signState(provider.secretKey, state);
    pWs.send(JSON.stringify({ nonce: n, owed: owed.toString(), units: (n * 250).toString(), ts: state.timestamp.toString(), providerSig: Buffer.from(providerSig).toString("hex") }));
    await new Promise((r) => setTimeout(r, 150));
  }
  await done;
  pWs.close(); cWs.close();

  // 4) Settle final co-signed state on-chain.
  await providerSdk.settle({
    payer: provider, node, asset: asset.publicKey, provider: provider.publicKey, consumer: consumer.publicKey,
    session, mplCore: MPL_CORE, state: latest!.state, providerSig: latest!.providerSig, consumerSig: latest!.consumerSig,
  });
  const n = await providerSdk.fetchNode(node);
  log("chain", `SETTLED. node reputation now ${n.reputation}, total_units ${n.totalUnits.toString()} — only 3 on-chain txs total.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
