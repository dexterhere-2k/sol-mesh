/** Two-terminal demo: provider side. Registers a node, then serves + settles.
 *  Usage: RPC=... ts-node client/examples/provider-cli.ts <provider-keypair.json>
 *  Prints the node asset pubkey for the consumer CLI to target. */
import { Keypair } from "@solana/web3.js";
import WebSocket from "ws";
import BN from "bn.js";
import { makeSdk, loadKeypair, MPL_CORE, RELAY, log } from "./common";
import { StateUpdate, signState, verifyStateSig } from "../src/state";

(async () => {
  const provider = loadKeypair(process.argv[2]);
  const sdk = makeSdk(provider);
  const asset = Keypair.generate();
  await sdk.registerNode(provider, asset, { name: "cli-node", uri: "https://solmesh.test/n.json", capacity: 1000, geo: "us-east" }, MPL_CORE);
  const node = sdk.nodePda(asset.publicKey);
  log("provider", `node ready. Run the consumer CLI with NODE_ASSET=${asset.publicKey.toBase58()}`);

  const sessionB58 = process.env.SESSION!; // consumer prints this; pass it in
  if (!sessionB58) { log("provider", "set SESSION=<session pubkey> (from consumer CLI) and re-run"); return; }
  const session = new (await import("@solana/web3.js")).PublicKey(sessionB58);

  const ws = new WebSocket(RELAY);
  ws.on("open", () => ws.send(JSON.stringify({ type: "join", session: sessionB58, role: "provider" })));

  let latest: any = null, owed = 0n;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.consumerSig) {
      const state: StateUpdate = { session, nonce: BigInt(m.nonce), owedToProvider: BigInt(m.owed), unitsConsumed: BigInt(m.units), timestamp: BigInt(m.ts) };
      latest = { state, providerSig: Buffer.from(m.providerSig, "hex"), consumerSig: Buffer.from(m.consumerSig, "hex") };
      log("provider", `co-signed tick #${m.nonce}`);
    }
  });

  // Serve 5 ticks.
  for (let n = 1; n <= 5; n++) {
    owed += 120_000_000n;
    const state: StateUpdate = { session, nonce: BigInt(n), owedToProvider: owed, unitsConsumed: BigInt(n * 250), timestamp: BigInt(Math.floor(Date.now() / 1000)) };
    const providerSig = signState(provider.secretKey, state);
    ws.send(JSON.stringify({ nonce: n, owed: owed.toString(), units: (n * 250).toString(), ts: state.timestamp.toString(), providerSig: Buffer.from(providerSig).toString("hex") }));
    await new Promise((r) => setTimeout(r, 400));
  }
  await new Promise((r) => setTimeout(r, 800));
  if (latest) {
    const consumerKey = (await sdk.fetchSession(session)).consumer;
    await sdk.settle({
      payer: provider, node, asset: asset.publicKey, provider: provider.publicKey,
      consumer: consumerKey, session, mplCore: MPL_CORE,
      state: latest.state, providerSig: latest.providerSig, consumerSig: latest.consumerSig,
    });
    log("provider", "settled on-chain.");
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
