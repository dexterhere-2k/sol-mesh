/** Two-terminal demo: consumer side. Opens a session against NODE_ASSET, co-signs ticks.
 *  Usage: RPC=... NODE_ASSET=<pubkey> ts-node client/examples/consumer-cli.ts <consumer-keypair.json> */
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import WebSocket from "ws";
import BN from "bn.js";
import { makeSdk, loadKeypair, RELAY, log } from "./common";
import { StateUpdate, signState, verifyStateSig } from "../src/state";

(async () => {
  const consumer = loadKeypair(process.argv[2]);
  const sdk = makeSdk(consumer);
  const asset = new PublicKey(process.env.NODE_ASSET!);
  const node = sdk.nodePda(asset);

  const seed = new BN(Date.now());
  await sdk.openSession(consumer, node, seed, new BN(LAMPORTS_PER_SOL), 3600, new BN(1));
  const session = sdk.sessionPda(node, consumer.publicKey, seed);
  log("consumer", `opened session. Pass SESSION=${session.toBase58()} to the provider CLI.`);

  const providerKey = (await sdk.fetchSession(session)).provider;
  const ws = new WebSocket(RELAY);
  ws.on("open", () => ws.send(JSON.stringify({ type: "join", session: session.toBase58(), role: "consumer" })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.consumerSig) return; // ignore our own echoes
    const state: StateUpdate = { session, nonce: BigInt(m.nonce), owedToProvider: BigInt(m.owed), unitsConsumed: BigInt(m.units), timestamp: BigInt(m.ts) };
    if (!verifyStateSig(providerKey, state, Buffer.from(m.providerSig, "hex"))) { log("consumer", "REJECTED bad provider sig"); return; }
    const consumerSig = signState(consumer.secretKey, state);
    ws.send(JSON.stringify({ ...m, consumerSig: Buffer.from(consumerSig).toString("hex") }));
    log("consumer", `co-signed tick #${m.nonce} (owed ${(Number(m.owed) / 1e9).toFixed(2)} SOL)`);
  });
})().catch((e) => { console.error(e); process.exit(1); });
