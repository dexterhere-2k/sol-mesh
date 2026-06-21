# SolMesh — DePIN State Settler

State-efficient settlement for micro-compute / storage / bandwidth networks on Solana.
Resource usage is metered **off-chain** via signed state channels; only **3 transactions
per session** ever touch the chain (node mint, escrow open, settlement). Settlement
verifies both parties' Ed25519 signatures on-chain and writes the new reputation score
directly onto the node's Metaplex Core NFT.

> Turbin3 Capstone · Rust + Anchor · Metaplex Core (`mpl-core`) · Ed25519 precompile + Instructions-sysvar introspection.

## Repository layout
```
solmesh/
├── SPEC.md                     # full build specification (source of truth)
├── Anchor.toml · Cargo.toml    # workspace
├── crates/solmesh-state/       # canonical StateUpdate (shared Rust<->TS)
├── programs/solmesh/           # the on-chain program
│   └── src/
│       ├── lib.rs              # entrypoint, 14 instructions
│       ├── state/              # Config, Node, Session
│       ├── crypto/ed25519.rs   # signature introspection (the crux)
│       ├── cpi/core.rs         # mpl-core create + reputation update
│       └── instructions/       # one module per ix
├── client/                     # TypeScript SDK + state-channel + relay
├── app/                        # Vite + React + wallet-adapter dApp
└── tests/                      # anchor mocha suite (incl. golden-bytes parity, security)
```

## Architecture (the trust boundary)
```
register_node ──┐                                   ┌── settle_session
                ▼                                   ▼
   [Metaplex Core NFT]      OFF-CHAIN STATE CHANNEL      [on-chain]
   capacity/geo/reputation   provider <—signed—> consumer  verify 2x ed25519
        ▲                    nonce++, owed+=, units+=      split escrow + fee
        └──── reputation CPI ◄───────────────────────────  refund consumer
                                                            update NFT reputation
   open_session → locks SOL/USDC into the session escrow PDA
```
Security comes from signatures, not the transport: forging a state requires forging an
Ed25519 signature. The only real attack is *withholding* a co-signature, which the
unilateral-close + challenge-window path neutralizes (highest co-signed nonce wins).

## Build & test
```bash
# prerequisites: rust, solana-cli, anchor 0.30.1, node 18+
npm install
anchor build
anchor test          # spins up localnet, clones the Core program, runs the suite
```
See `SPEC.md §11` for the M0→M9 milestone order and per-milestone acceptance tests,
and `SPEC.md §12` for version-pinning gotchas (especially the Ed25519 instruction
byte-layout golden test and the `mpl-core` version pin).

## Frontend
```bash
cd app && npm install && VITE_RPC=http://localhost:8899 npm run dev
```

## Rejected approach (capstone writeup)
In-program Ed25519 verification via `curve25519-dalek` was rejected: it is far too
compute-heavy for Solana's per-instruction CU budget. SolMesh instead uses the native
`Ed25519SigVerify111…` precompile and proves binding via Instructions-sysvar
introspection — see `programs/solmesh/src/crypto/ed25519.rs`.

## Status / caveats
This repo was generated as a complete, internally consistent scaffold. Before `anchor
test` goes green you must: (1) pin `mpl-core` to the version matching the Core program
on your cluster and adjust the CPI builder calls if its plugin API differs; (2) confirm
the Ed25519 instruction byte layout via the M3 golden-bytes test (the self-contained
`u16::MAX` index assumption in `ed25519.rs`); (3) clone the real Core program id into
the local validator (`Anchor.toml` + `tests/helpers.ts`).
