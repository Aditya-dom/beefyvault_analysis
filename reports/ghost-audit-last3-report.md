# Ghost Audit - Beefy cbETH/ETH (Base) - Last 3 Harvests

Generated: 2026-02-15

## TL;DR

- Total execution gap across the last 3 harvests: **0.002262631260647855 WETH**
- Biggest miss: realized harvest at **block 41455212** vs optimal **block 41454845**
- Blind-keeper signal confirmed: `callReward()` is hardcoded to `0`

## Target

| Field | Value |
| --- | --- |
| Strategy | `0x47bA57B0522bdd422B81f7a2e075B2fE1Db3f99B` |
| Vault | `0xa06C351648dA44078a36c811285ee5eBE74bA089` |
| Want | `0x98244d93D42b42aB3E3A4D12A5dc0B3e7f8F32f9` (`cbeth-f`) |
| Native | `0x4200000000000000000000000000000000000006` (`WETH`) |

## On-Chain Validation (Wiring + "Blind Keeper")

- `strategy.vault == vault` and `vault.strategy == strategy` (matches).
- Reward config observed on-chain for this strategy:
  - 2 Curve rewards: `CRV` + `crvUSD` (both swapped to WETH via Curve routes).
  - `rewardsV3Length == 0`.
- `callReward()` is hardcoded to return `0` on-chain.

## Method (Ghost Audit)

For each realized harvest tx:

1. Fork Base state at ~1 hour before the realized block (`realizedBlock - 767`).
2. For each candidate block in the window, every 20 blocks (inclusive), simulate a standalone `harvest()`:
   - Reset fork to `candidateBlock - 1`
   - Send `harvest()` so it mines at `candidateBlock`
3. Measure:
   - **Gross (native)**: total `WETH` (`native`) `Transfer` out of the strategy during the simulated harvest tx.
   - **Gas cost**: `gasUsed * effectiveGasPrice` (L2 execution cost).
   - **Net (native)**: `gross - gasCost`.
4. Choose the O(1)-optimal block in the window: the candidate block with max net.
5. Compute leakage: `optimalNet - realizedNet`.

## Results (Last 3 Harvests)

All amounts below are in **WETH (ETH units)**, per the method above.

| Realized Block | Harvest Tx | Window (Start->End) | Realized Net | Optimal Block | Optimal Net | Delta Net |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 41493767 | `0x1f19267099524175eb02901712c87f07185cd4f422e45f592b469b02b9b33122` | 41493000->41493767 | 0.0004309721 | 41493767 | 0.0004309721 | 0 |
| 41455212 | `0x0501a6d0af5af133385e9cb5741a2c223466390a478383b89200b01d2add21ac` | 41454445->41455212 | -0.0014979319 | 41454845 | 0.0007646994 | **0.0022626313** |
| 41416837 | `0xe58d4887cb89d9b1f98506b125b51209c20b355a4e4442ffc8cd32f3b622e933` | 41416070->41416837 | -0.0006457169 | 41416837 | -0.0006457169 | 0 |

**Total delta across these 3 harvests:** `0.002262631260647855 WETH` (entirely from the 41455212 window).

### Gross/Gas Breakdown (Realized vs Optimal)

| Realized Block | Realized Gross | Realized Gas | Realized Net | Optimal Block | Optimal Gross | Optimal Gas | Optimal Net |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 41493767 | 0.0016796650 | 0.0012486929 | 0.0004309721 | 41493767 | 0.0016796650 | 0.0012486929 | 0.0004309721 |
| 41455212 | 0.0000000000 | 0.0014979319 | -0.0014979319 | 41454845 | 0.0020228960 | 0.0012581966 | 0.0007646994 |
| 41416837 | 0.0006042624 | 0.0012499793 | -0.0006457169 | 41416837 | 0.0006042624 | 0.0012499793 | -0.0006457169 |

## Keeper PnL Proxy (Call Fee Minus Gas)

Even though the strategy harvest is permissionless, the built-in call incentive is effectively "blind":

- `keeperCallFeeMinusGas` at realized blocks:
  - 41493767: `-0.001248524945130862 WETH`
  - 41455212: `-0.001497931887861078 WETH`
  - 41416837: `-0.001249918901875916 WETH`

## Key Observations

- The middle sample (block `41455212`) shows a clear execution gap: within the scanned window, there existed a block (`41454845`) where the standalone harvest simulation yields positive net, while the realized block is value-negative by the same metric.
- Two samples show zero delta within the scanned window (realized already optimal), but still exhibit strongly negative `callFee - gas`, consistent with the "keeper flying blind" thesis.

## Artifacts

Merged per-harvest reports:

- `/Users/arawn/Desktop/beefyvault/reports/ghost-audit-0x47bA57B0522bdd422B81f7a2e075B2fE1Db3f99B-41493767-merged.json`
- `/Users/arawn/Desktop/beefyvault/reports/ghost-audit-0x47bA57B0522bdd422B81f7a2e075B2fE1Db3f99B-41455212-merged.json`
- `/Users/arawn/Desktop/beefyvault/reports/ghost-audit-0x47bA57B0522bdd422B81f7a2e075B2fE1Db3f99B-41416837-merged.json`

Combined last-3 summary:

- `/Users/arawn/Desktop/beefyvault/reports/ghost-audit-last3-summary.json`

## Notes / Limitations

- The "gross" metric is **native (WETH) outflow from the strategy** during harvest, which is a proxy for "reward value processed" in native terms, not a direct measurement of vault profit in want terms.
- The gas-cost model here is `gasUsed * effectiveGasPrice` (L2 execution). Base receipts also include separate L1 data fee fields; those are not included in this net calculation.
- The simulation places the standalone harvest as the first tx mined in the candidate block (no intra-block ordering against other real txs).
