# Tests

Run with `anchor test` (spins up a local validator, clones the Core program, runs all specs).
The singleton `Config` is created idempotently by `ensureConfig()` in `helpers.ts`, so files
run in any order. The dispute test uses a short `TEST_CHALLENGE_WINDOW` (3s) so it can wait it out.

| File | Milestone | Covers |
|---|---|---|
| 01_config.ts | M1 | config init (idempotent), fee bound, admin update |
| 02_register_node.ts | M1 | Core mint, Node fields, asset owned by Core program |
| 03_open_session.ts | M2 | escrow funding to the lamport, cancel + expire refunds |
| 04_state_channel.ts | M3 | **Rust↔TS golden-bytes parity**, co-sign roundtrip, **ed25519 byte-layout assertion** |
| 05_settle_happy.ts | M4 | settle splits funds + reputation bump |
| 06_checkpoint.ts | M5 | cumulative checkpoints, no double-pay on final settle, stale-nonce reject |
| 07_unilateral_challenge.ts | M6 | higher-nonce challenge wins, lower rejected, post-deadline rejected, finalize |
| 08_expire_cancel.ts | M2 | expire-with-checkpoint, cancel-after-usage rejection |
| 09_security.ts | M7 | forged sig / over-deposit rejection |
| 10_spl_escrow.ts | M8 | USDC-style mint: open_session_spl + settle_session_spl token split + reputation |

All 9 spec'd files plus the SPL file now exist. The SPL path (10) is the least
runtime-verified — validate it first if your `mpl-core`/`anchor-spl` versions differ.
