import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Connection } from "@solana/web3.js";
import { SolMesh } from "../client/src/sdk";

// Replace with the real Core program id you cloned into the local validator.
export const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

// Deterministic shared admin so every test file can reuse / update the singleton Config.
const ADMIN_SEED = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
export const ADMIN = Keypair.fromSeed(ADMIN_SEED);

// Short challenge window so the dispute test can wait it out in real time.
export const TEST_CHALLENGE_WINDOW = 3;

export function setup() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Solmesh as anchor.Program;
  const sdk = new SolMesh(program, provider.connection);
  return { provider, program, sdk, connection: provider.connection };
}

export async function airdrop(connection: Connection, to: PublicKey, sol = 10) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

export async function fundedKeypair(connection: Connection, sol = 10) {
  const kp = Keypair.generate();
  await airdrop(connection, kp.publicKey, sol);
  return kp;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Idempotently ensure the singleton Config exists (initialized by ADMIN). */
export async function ensureConfig(sdk: SolMesh, connection: Connection, feeBps = 50, challengeWindowSecs = TEST_CHALLENGE_WINDOW) {
  const info = await connection.getAccountInfo(sdk.configPda());
  if (info) return;
  await airdrop(connection, ADMIN.publicKey, 5);
  await sdk.initializeConfig(ADMIN, feeBps, challengeWindowSecs, MPL_CORE);
}

/** Register a node + open a funded session; returns all the handles a test needs. */
export async function newSession(sdk: SolMesh, connection: Connection, opts: { deposit?: number; durationSecs?: number } = {}) {
  const BN = anchor.BN;
  const provider = await fundedKeypair(connection);
  const consumer = await fundedKeypair(connection);
  const asset = Keypair.generate();
  await sdk.registerNode(provider, asset, { name: "n", uri: "https://x/y.json", capacity: 1000, geo: "us-east", initReputation: 0 }, MPL_CORE);
  const nodePda = sdk.nodePda(asset.publicKey);
  const seed = new BN(Date.now() + Math.floor(Math.random() * 1e6));
  const deposit = new BN((opts.deposit ?? 1) * LAMPORTS_PER_SOL);
  await sdk.openSession(consumer, nodePda, seed, deposit, opts.durationSecs ?? 3600, new BN(1));
  const session = sdk.sessionPda(nodePda, consumer.publicKey, seed);
  return { provider, consumer, asset, nodePda, seed, session, deposit };
}

export const GOLDEN_STATE_HEX = "534f4c4d4553483107070707070707070707070707070707070707070707070707070707070707070300000000000000e8030000000000002a0000000000000000f1536500000000";
