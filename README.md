# Beefy Vault Optimizer (Ghost Audit Harness)

Fork-based simulation harness to quantify harvest execution leakage for Beefy-style strategies (gas timing + swap timing).

## Current Target

- Strategy: `0x47bA57B0522bdd422B81f7a2e075B2fE1Db3f99B`
- Vault: `0xa06C351648dA44078a36c811285ee5eBE74bA089`
- Logic family: `StandardStrategyCurveConvexL2`
- Keeper blind spot: `callReward()` is hardcoded to `0`

## What Is Implemented

- Strategy/vault wiring validation.
- Forked `harvest()` simulation across configurable block windows.
- Realized-vs-optimal block delta analysis.
- Net scoring metric:
  - `netProfitEthWei = (wantHarvested * wantPriceWei / 1e18) - (l2GasCostWei + l1FeeWei)`
- L1 data fee inclusion (Base gas oracle).
- Want-denominated and ETH-denominated outputs.
- Route-level attribution from transfer logs.

## Repo Layout

- `scripts/ghost-audit.mjs`: core simulation and per-run report generation.
- `scripts/run-ghost-audit-parallel.sh`: orchestrates Anvil workers + parallel offsets.
- `scripts/find-window-start.mjs`: computes start block by timestamp delta.
- `scripts/merge-ghost-reports.mjs`: merges offset reports into one merged report.
- `scripts/render-last3-report.mjs`: builds consolidated human-readable markdown from merged reports.
- `config/targets/base-cbeth-eth.json`: target metadata.
- `reports/`: generated outputs and markdown reports.

## Prerequisites

- Foundry (`anvil`) in `PATH`.
- Node.js + npm.
- A Base archive RPC endpoint (do not commit API keys).

## Install

```bash
npm install
```

## Configuration

Use local (gitignored) runtime config:

```bash
cp config/run.env.example config/run.env
```

Then edit `config/run.env` with your RPC and run settings.

## Run A 6-Hour Ghost Audit

Example: latest harvest calibration case.

```bash
npm run ghost-audit:parallel -- \
  --realized-block 41493767 \
  --tx-hash 0x1f19267099524175eb02901712c87f07185cd4f422e45f592b469b02b9b33122 \
  --window-seconds 21600 \
  --offsets 0,20 \
  --step 40
```

Merge offset outputs:

```bash
REALIZED_BLOCK=41493767 RUN_TAGS=offset-0,offset-20 npm run ghost-audit:merge
```

Generate consolidated markdown (last-3 harvest view):

```bash
node scripts/render-last3-report.mjs
```

## Notes

- Full 6-hour windows at 20-block cadence are heavy; public/free RPC tiers often throttle under repeated fork resets.
