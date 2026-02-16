#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { formatUnits } from "viem";

const STRATEGY =
  process.env.STRATEGY ?? "0x47bA57B0522bdd422B81f7a2e075B2fE1Db3f99B";
const REALIZED_BLOCK = Number(process.env.REALIZED_BLOCK ?? 41493767);
const REPORT_DIR = process.env.REPORT_DIR ?? "reports";
const RUN_TAGS = (process.env.RUN_TAGS ?? "offset-0,offset-20,offset-40,offset-60")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

function toEth(wei) {
  return Number(formatUnits(BigInt(wei), 18));
}

async function readReport(tag) {
  const reportPath = path.resolve(
    REPORT_DIR,
    `ghost-audit-${STRATEGY}-${REALIZED_BLOCK}-${tag}.json`
  );
  const raw = await fs.readFile(reportPath, "utf8");
  return { reportPath, report: JSON.parse(raw) };
}

async function run() {
  const loaded = await Promise.all(RUN_TAGS.map(readReport));
  const base = loaded[0].report;

  const rowsByBlock = new Map();
  for (const { report } of loaded) {
    for (const row of report.rows ?? []) {
      if (!row?.ok) continue;
      rowsByBlock.set(Number(row.block), row);
    }
  }

  const rows = [...rowsByBlock.values()].sort((a, b) => a.block - b.block);
  if (rows.length === 0) {
    throw new Error("No successful rows found while merging reports.");
  }

  const scored = rows.map((row) => ({
    block: Number(row.block),
    netProfitEthWei: BigInt(row.estimated.netProfitEthWei),
    netProfitWantWei: BigInt(row.estimated.netProfitWantWei),
    grossProfitEthWei: BigInt(row.estimated.grossProfitEthWei),
    grossProfitWantWei: BigInt(row.estimated.grossProfitWantWei),
    netNativeAfterGasWei: BigInt(row.estimated.netNativeAfterGasWei),
    grossNativeOutWei: BigInt(row.estimated.grossNativeOutWei),
    gasCostWei: BigInt(row.gasCostWei),
    l2GasCostWei: BigInt(row.l2GasCostWei ?? 0),
    l1FeeWei: BigInt(row.l1FeeWei ?? 0),
    keeperCallFeeMinusGasWei: BigInt(row.estimated.keeperCallFeeMinusGasWei),
    row,
  }));

  scored.sort((a, b) =>
    a.netProfitEthWei > b.netProfitEthWei
      ? -1
      : a.netProfitEthWei < b.netProfitEthWei
      ? 1
      : 0
  );

  const optimal = scored[0];
  const realizedRow =
    base?.realized ??
    scored.find((x) => x.block === REALIZED_BLOCK)?.row ??
    null;
  if (!realizedRow) {
    throw new Error(`Missing realized metrics for block ${REALIZED_BLOCK}.`);
  }

  const realizedNetProfitEthWei = BigInt(realizedRow.estimated.netProfitEthWei);
  const realizedGrossProfitEthWei = BigInt(realizedRow.estimated.grossProfitEthWei);
  const realizedGasCostWei = BigInt(realizedRow.gasCostWei);

  const optimalGrossProfitEthWei = BigInt(optimal.row.estimated.grossProfitEthWei);
  const optimalGasCostWei = BigInt(optimal.row.gasCostWei);

  const deltaNet = optimal.netProfitEthWei - realizedNetProfitEthWei;
  const deltaGrossProfitEthWei =
    optimalGrossProfitEthWei - realizedGrossProfitEthWei;
  const deltaGas = optimalGasCostWei - realizedGasCostWei;

  const merged = {
    mergedFromTags: RUN_TAGS,
    mergedFromFiles: loaded.map((x) => x.reportPath),
    target: {
      strategy: STRATEGY,
      realizedBlock: REALIZED_BLOCK,
      windowStart: base?.target?.windowStart,
      windowEnd: base?.target?.windowEnd,
      step: 20,
      blocksSimulated: rows.length,
    },
    strategyValidation: base.strategyValidation,
    tokenMeta: base.tokenMeta,
    scoringMetric: base.scoringMetric,
    realized: realizedRow,
    realizedSimulated: base?.realizedSimulated ?? null,
    optimal: optimal.row,
    delta: {
      netProfitEthWei: deltaNet.toString(),
      grossProfitEthWei: deltaGrossProfitEthWei.toString(),
      gasCostWei: deltaGas.toString(),
      netProfitEth: toEth(deltaNet.toString()),
      grossProfitEth: toEth(deltaGrossProfitEthWei.toString()),
      gasCostEth: toEth(deltaGas.toString()),
    },
    top5ByNetProfitEth: scored.slice(0, 5).map((s) => ({
      block: s.block,
      netProfitEthWei: s.netProfitEthWei.toString(),
      netProfitEth: toEth(s.netProfitEthWei.toString()),
      netProfitWantWei: s.netProfitWantWei.toString(),
      grossProfitEthWei: s.grossProfitEthWei.toString(),
      grossProfitEth: toEth(s.grossProfitEthWei.toString()),
      grossProfitWantWei: s.grossProfitWantWei.toString(),
      grossNativeOutWei: s.grossNativeOutWei.toString(),
      grossNativeOutEth: toEth(s.grossNativeOutWei.toString()),
      gasCostWei: s.gasCostWei.toString(),
      gasCostEth: toEth(s.gasCostWei.toString()),
      l2GasCostWei: s.l2GasCostWei.toString(),
      l2GasCostEth: toEth(s.l2GasCostWei.toString()),
      l1FeeWei: s.l1FeeWei.toString(),
      l1FeeEth: toEth(s.l1FeeWei.toString()),
      keeperCallFeeMinusGasWei: s.keeperCallFeeMinusGasWei.toString(),
      keeperCallFeeMinusGasEth: toEth(s.keeperCallFeeMinusGasWei.toString()),
    })),
    rows,
  };

  const outPath = path.resolve(
    REPORT_DIR,
    `ghost-audit-${STRATEGY}-${REALIZED_BLOCK}-merged.json`
  );
  await fs.writeFile(outPath, JSON.stringify(merged, null, 2));

  console.log(`Merged report: ${outPath}`);
  console.log(`Realized net: ${toEth(realizedRow.estimated.netProfitEthWei)} ETH`);
  console.log(
    `Optimal net:  ${toEth(optimal.row.estimated.netProfitEthWei)} ETH @ block ${optimal.block}`
  );
  console.log(`Delta net:    ${toEth(deltaNet.toString())} ETH`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
