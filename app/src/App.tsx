import React, { useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import nacl from "tweetnacl";
import { useLog } from "./lib/useLog";
import { serializeState } from "../../client/src/state";

// In a production app you'd wire the Anchor Program + SolMesh SDK to the connected
// wallet. For the capstone demo we keep ephemeral provider/consumer keypairs so the
// full state-channel lifecycle can run end-to-end against localnet.

export default function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { lines, log } = useLog();

  const [provider] = useState(() => Keypair.generate());
  const [consumer] = useState(() => Keypair.generate());
  const [session] = useState(() => Keypair.generate().publicKey);
  const [nonce, setNonce] = useState(0);
  const [owed, setOwed] = useState(0);
  const [units, setUnits] = useState(0);
  const [deposit, setDeposit] = useState(1);
  const [geo, setGeo] = useState("us-east");
  const [capacity, setCapacity] = useState(1000);

  // Simulate one off-chain usage tick: both parties co-sign the new cumulative state.
  function tick() {
    const n = nonce + 1;
    const newOwed = owed + 100_000_000; // +0.1 SOL owed
    const newUnits = units + 250;
    const state = {
      session,
      nonce: BigInt(n),
      owedToProvider: BigInt(newOwed),
      unitsConsumed: BigInt(newUnits),
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    };
    const msg = serializeState(state);
    const ps = nacl.sign.detached(msg, provider.secretKey);
    const cs = nacl.sign.detached(msg, consumer.secretKey);
    const ok =
      nacl.sign.detached.verify(msg, ps, provider.publicKey.toBytes()) &&
      nacl.sign.detached.verify(msg, cs, consumer.publicKey.toBytes());
    setNonce(n); setOwed(newOwed); setUnits(newUnits);
    log(`tick #${n}: owed=${(newOwed / 1e9).toFixed(2)} SOL, units=${newUnits}, co-signed=${ok ? "OK" : "FAIL"} (0 on-chain txs)`);
  }

  return (
    <div className="wrap">
      <header>
        <div>
          <h1>SolMesh <span className="pill">DePIN State Settler</span></h1>
          <div className="tag">Mint node NFT · open escrow · stream signed off-chain state · settle on-chain</div>
        </div>
        <WalletMultiButton />
      </header>

      <div className="grid">
        <div className="card">
          <h2>1 · Register node (Metaplex Core)</h2>
          <label>Geo</label>
          <input value={geo} onChange={(e) => setGeo(e.target.value)} />
          <label>Capacity</label>
          <input type="number" value={capacity} onChange={(e) => setCapacity(+e.target.value)} />
          <button disabled={!wallet.connected} onClick={() => log(`registerNode(geo=${geo}, capacity=${capacity}) — call SDK.registerNode here`)}>
            Mint node NFT
          </button>
        </div>

        <div className="card">
          <h2>2 · Open session (lock SOL)</h2>
          <label>Deposit (SOL)</label>
          <input type="number" value={deposit} onChange={(e) => setDeposit(+e.target.value)} />
          <button disabled={!wallet.connected} onClick={() => log(`openSession(deposit=${deposit} SOL) — call SDK.openSession here`)}>
            Lock escrow
          </button>
        </div>

        <div className="card">
          <h2>3 · State channel (off-chain)</h2>
          <div className="tag">Each tick is co-signed by both parties. Nothing hits the chain.</div>
          <div className="row" style={{ marginTop: 12 }}>
            <div><label>nonce</label><input value={nonce} readOnly /></div>
            <div><label>owed (SOL)</label><input value={(owed / 1e9).toFixed(2)} readOnly /></div>
            <div><label>units</label><input value={units} readOnly /></div>
          </div>
          <button onClick={tick}>Simulate usage tick →</button>
        </div>

        <div className="card">
          <h2>4 · Settle on-chain</h2>
          <div className="tag">Submit final co-signed state + 2 Ed25519 ixs. Splits escrow, updates NFT reputation.</div>
          <button className="secondary" disabled={nonce === 0} onClick={() => log(`settleSession(nonce=${nonce}, owed=${(owed / 1e9).toFixed(2)} SOL) — build ed25519 ixs + SDK.settle here`)}>
            Settle &amp; close
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Activity log</h2>
        <div className="log">{lines.length ? lines.join("\n") : "Connect a wallet and run the flow…"}</div>
      </div>
    </div>
  );
}
