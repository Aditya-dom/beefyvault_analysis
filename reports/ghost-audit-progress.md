# Ghost Audit Progress (Anvil)

## Scope Status

- Strategy wiring + reward/swap topology validation: **completed**
- callReward() blind-keeper check: **completed** (`callReward() = 0` onchain)
- Metric upgrades (want-denominated PnL, L1 data fee, route attribution): **implemented**
- 6-hour x 20-block full sweeps for 3 harvests: **still blocked by RPC throughput limits**

## Calibrated Smoke Result (latest harvest)

- Realized block: `41493767`
- Tx: `0x1f19267099524175eb02901712c87f07185cd4f422e45f592b469b02b9b33122`
- Test window: `41493747 -> 41493767` (2 points @ 20-block cadence)

| Metric | Value |
|---|---:|
| Realized net profit (ETH) | 0.000706764648 |
| Optimal simulated net profit (ETH) | 0.000710238243 |
| Net delta (ETH left on table) | 0.000003473595 |

Source file:
- `reports/ghost-audit-0x47bA57B0522bdd422B81f7a2e075B2fE1Db3f99B-41493767-offset-0.json`

## Blocker Detail

- A true 6-hour Base window at 20-block cadence is large: for block `41493767`, computed start is `41482967`, which is **541 simulation points**.
- With the provided archive endpoint:
  - Single-worker flow is stable but slow for 541 points.
  - Multi-worker sharding improves speed but can still trigger sustained provider throttling (`HTTP 429`) during repeated `anvil_reset` / storage fetch cycles.
- Runner reliability has been improved:
  - waits for explicit `Listening on` before starting workers
  - supports configurable worker/anvil start staggering to smooth bursts

## Next Step To Unblock E2E

Use a higher-throughput dedicated Base archive endpoint (paid/raised limits) and rerun the same pipeline with current scripts.
