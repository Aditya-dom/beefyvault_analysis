# Beefy Vault Optimizer (Ghost Audit Harness)

This repo contains a fork-based simulation harness to quantify harvest execution leakage (gas timing + swap timing) for Beefy-style strategies.

## What's Here

- `scripts/ghost-audit.mjs`: simulates `harvest()` across a block window and computes realized-vs-optimal delta.
- `scripts/run-ghost-audit-parallel.sh`: runs the sweep with 2 workers (offset 0/20) to cover a 20-block grid without RPC rate limiting.
- `scripts/merge-ghost-reports.mjs`: merges worker outputs into a single report.
- `reports/`: human + machine outputs for completed audits.

## Prereqs

- Foundry installed (`anvil` in PATH).
- Node.js + npm.

## Install

```bash
npm install
```

## Run A Ghost Audit

Default target is the Base cbETH/ETH strategy used for calibration.

Run a 1-hour style sweep (realized block minus ~767 blocks, simulate every 20 blocks):

```bash
FORK_RPC_URL=https://base-mainnet.public.blastapi.io \\
REALIZED_BLOCK=41493767 \\
BASE_START_BLOCK=41493000 \\
npm run ghost-audit:parallel

REALIZED_BLOCK=41493767 RUN_TAGS=offset-0,offset-20 npm run ghost-audit:merge
```

Outputs are written under `reports/`.

## Notes

- Net metric used: `WETH transfer out of strategy during harvest - (gasUsed * effectiveGasPrice)`.
- L1 data fees (Base receipt fields) are not included in the gas-cost model.
