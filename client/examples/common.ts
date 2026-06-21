import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import fs from "fs";
import { SolMesh } from "../src/sdk";

export const MPL_CORE = new anchor.web3.PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const RPC = process.env.RPC ?? "http://localhost:8899";
export const RELAY = process.env.RELAY ?? "ws://localhost:8787";

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

/** Build a SolMesh SDK bound to `wallet` against the program IDL on disk. */
export function makeSdk(wallet: Keypair): SolMesh {
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(__dirname + "/../../target/idl/solmesh.json", "utf8"));
  const program = new anchor.Program(idl, provider);
  return new SolMesh(program, connection);
}

export const log = (who: string, msg: string) => console.log(`[${who}] ${msg}`);
