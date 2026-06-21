# SolMesh dApp (frontend)

Vite + React + Solana wallet-adapter demo UI for the full SolMesh lifecycle.

```bash
cd app
npm install
VITE_RPC=http://localhost:8899 npm run dev
```

The four panels mirror the on-chain instructions: register node → open session →
stream co-signed off-chain state (state channel) → settle. The state-channel panel
runs entirely client-side (no chain txs) to demonstrate the throughput claim:
arbitrarily many usage ticks, only 3 on-chain transactions per session.

To make the buttons hit the chain, instantiate the `SolMesh` SDK from
`client/src/sdk.ts` with an Anchor `Program` built against the connected wallet and
replace the `log(...)` placeholders with the corresponding SDK calls.
