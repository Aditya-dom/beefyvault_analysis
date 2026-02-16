#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { formatUnits } from "viem";

const STRATEGY =
  process.env.STRATEGY ?? "0x47bA57B0522bdd422B81f7a2e075B2fE1Db3f99B";
const REPORT_DIR = process.env.REPORT_DIR ?? "reports";
const OUT_SUMMARY =
  process.env.OUT_SUMMARY ?? path.resolve(REPORT_DIR, "ghost-audit-last3-summary.json");
const OUT_MD =
  process.env.OUT_MD ?? path.resolve(REPORT_DIR, "ghost-audit-last3-report.md");

const LAST3 = (process.env.LAST3_BLOCKS ?? "41493767,41455212,41416837")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter(Boolean);

function toEth(wei) {
  return Number(formatUnits(BigInt(wei), 18));
}

function fmtEth(wei, digits = 6) {
  return toEth(wei).toFixed(digits);
}

function fmtUnits(raw, decimals, digits = 6) {
  return Number(formatUnits(BigInt(raw), decimals)).toFixed(digits);
}

function pct(numerator, denominator) {
  if (denominator === 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function lc(addr) {
  return String(addr).toLowerCase();
}

async function readMerged(realizedBlock) {
  const p = path.resolve(
    REPORT_DIR,
    `ghost-audit-${STRATEGY}-${realizedBlock}-merged.json`
  );
  const raw = await fs.readFile(p, "utf8");
  return { path: p, report: JSON.parse(raw) };
}

function extractKeyMetrics(row) {
  const wantPriceWei = row?.estimated?.wantPricing?.priceWei ?? "0";
  const wantPriceEth = toEth(wantPriceWei);
  return {
    block: Number(row.block),
    txHash: row.txHash ?? null,
    wantPriceWei,
    wantPriceEth,
    grossProfitEthWei: row.estimated.grossProfitEthWei,
    netProfitEthWei: row.estimated.netProfitEthWei,
    grossProfitWantWei: row.estimated.grossProfitWantWei,
    netProfitWantWei: row.estimated.netProfitWantWei,
    gasCostWei: row.gasCostWei,
    l2GasCostWei: row.l2GasCostWei,
    l1FeeWei: row.l1FeeWei,
    wantHarvestedWei: row.stratHarvest?.wantHarvested ?? "0",
    keeperCallFeeMinusGasWei: row.estimated.keeperCallFeeMinusGasWei,
  };
}

function buildRouteAttribution({ row, tokenMeta }) {
  const sold = row?.swapAttribution?.rewardSoldByToken ?? {};
  const nativeIn = row?.swapAttribution?.nativeInByReward ?? {};

  const out = [];
  for (const tokenLower of Object.keys({ ...sold, ...nativeIn })) {
    const meta = tokenMeta?.[tokenLower] ?? { symbol: tokenLower.slice(0, 6), decimals: 18 };
    const soldRaw = sold[tokenLower] ?? "0";
    const nativeInRaw = nativeIn[tokenLower] ?? "0";
    const soldDec = fmtUnits(soldRaw, meta.decimals, 6);
    const nativeInEth = fmtEth(nativeInRaw, 6);

    const soldF = Number(formatUnits(BigInt(soldRaw), meta.decimals));
    const nativeF = toEth(nativeInRaw);
    const px = soldF > 0 ? (nativeF / soldF).toExponential(6) : "n/a";

    out.push({
      token: meta.symbol,
      tokenAddress: tokenLower,
      soldRaw,
      soldDec,
      nativeInRaw,
      nativeInEth,
      priceEthPerToken: px,
    });
  }

  out.sort((a, b) => a.token.localeCompare(b.token));
  return out;
}

async function run() {
  const loaded = await Promise.all(LAST3.map(readMerged));
  const reports = loaded.map((x) => x.report);
  const first = reports[0];

  const vault =
    first?.strategyValidation?.wiring?.expectedVault ??
    first?.strategyValidation?.wiring?.strategyVault ??
    null;

  const rows = reports.map((r) => {
    const realized = extractKeyMetrics(r.realized);
    const optimal = extractKeyMetrics(r.optimal);

    const deltaNetEth = toEth(r.delta.netProfitEthWei);
    const realizedNetEth = toEth(realized.netProfitEthWei);
    const optimalNetEth = toEth(optimal.netProfitEthWei);

    const tokenMeta = r.tokenMeta ?? {};
    const realizedRoute = buildRouteAttribution({ row: r.realized, tokenMeta });
    const optimalRoute = buildRouteAttribution({ row: r.optimal, tokenMeta });

    return {
      realizedBlock: Number(r?.target?.realizedBlock),
      txHash: r?.target?.txHash ?? realized.txHash ?? null,
      windowStart: Number(r?.target?.windowStart),
      windowEnd: Number(r?.target?.windowEnd),
      blocksSimulated: Number(r?.target?.blocksSimulated),
      scoringMetric: r?.scoringMetric,
      realized,
      optimal,
      delta: {
        netProfitEthWei: r.delta.netProfitEthWei,
        netProfitEth: deltaNetEth,
        realizedNetProfitEth: realizedNetEth,
        optimalNetProfitEth: optimalNetEth,
      },
      routeAttribution: {
        realized: realizedRoute,
        optimal: optimalRoute,
      },
      reportPath: loaded.find((x) => x.report.target.realizedBlock === r.target.realizedBlock)?.path ?? null,
    };
  });

  const totalDeltaNetEth = rows.reduce((acc, x) => acc + x.delta.netProfitEth, 0);

  const summary = {
    generatedAt: new Date().toISOString(),
    chain: "base",
    strategy: STRATEGY,
    vault,
    methodology:
      "6h-by-timestamp window ending at realized block; candidate blocks sampled on a 20-block grid. Realized metrics from on-chain receipt; candidates from Anvil fork simulation. Net profit metric: wantHarvested valued via Curve LP virtual price minus (L2 gas + L1 data fee).",
    rows,
    totalDeltaNetEth,
  };

  await fs.mkdir(path.dirname(OUT_SUMMARY), { recursive: true });
  await fs.writeFile(OUT_SUMMARY, JSON.stringify(summary, null, 2));

  const md = [];
  md.push(`# Ghost Audit - Beefy cbETH/ETH (Base) - Last 3 Harvests (6h window)`);
  md.push(``);
  md.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  md.push(``);
  md.push(`## TL;DR`);
  md.push(``);
  md.push(`- Total execution gap (best simulated net minus realized net): **${totalDeltaNetEth.toFixed(6)} ETH**`);
  md.push(`- Strategy: \`${STRATEGY}\``);
  if (vault) md.push(`- Vault: \`${vault}\``);
  md.push(``);
  md.push(`## Results`);
  md.push(``);
  md.push(
    `| Realized Block | Tx | Window (Start->End) | Realized Net (ETH) | Optimal Block | Optimal Net (ETH) | Delta Net (ETH) |`
  );
  md.push(`| ---: | --- | --- | ---: | ---: | ---: | ---: |`);
  for (const r of rows) {
    const tx = r.txHash ? `\`${r.txHash}\`` : "`(missing)`";
    md.push(
      `| ${r.realizedBlock} | ${tx} | ${r.windowStart}->${r.windowEnd} | ${r.delta.realizedNetProfitEth.toFixed(
        6
      )} | ${r.optimal.block} | ${r.delta.optimalNetProfitEth.toFixed(6)} | **${r.delta.netProfitEth.toFixed(
        6
      )}** |`
    );
  }
  md.push(``);
  md.push(`## Detail (Realized vs Optimal)`);
  md.push(``);
  for (const r of rows) {
    md.push(`### Block ${r.realizedBlock}`);
    md.push(``);
    md.push(`- Window: ${r.windowStart}->${r.windowEnd} (simulated points: ${r.blocksSimulated})`);
    md.push(`- Realized tx: ${r.txHash ? `\`${r.txHash}\`` : "`(missing)`"}`);
    md.push(`- Optimal simulated block: ${r.optimal.block}`);
    md.push(``);
    md.push(`| Metric | Realized | Optimal | Delta |`);
    md.push(`| --- | ---: | ---: | ---: |`);
    md.push(
      `| Gross profit (want) | ${fmtEth(r.realized.grossProfitWantWei, 6)} | ${fmtEth(
        r.optimal.grossProfitWantWei,
        6
      )} | ${fmtEth(BigInt(r.optimal.grossProfitWantWei) - BigInt(r.realized.grossProfitWantWei), 6)} |`
    );
    md.push(
      `| Gross profit (ETH) | ${fmtEth(r.realized.grossProfitEthWei, 6)} | ${fmtEth(
        r.optimal.grossProfitEthWei,
        6
      )} | ${fmtEth(BigInt(r.optimal.grossProfitEthWei) - BigInt(r.realized.grossProfitEthWei), 6)} |`
    );
    md.push(
      `| Total gas (ETH) | ${fmtEth(r.realized.gasCostWei, 6)} | ${fmtEth(
        r.optimal.gasCostWei,
        6
      )} | ${fmtEth(BigInt(r.optimal.gasCostWei) - BigInt(r.realized.gasCostWei), 6)} |`
    );
    md.push(
      `| Net profit (ETH) | ${fmtEth(r.realized.netProfitEthWei, 6)} | ${fmtEth(
        r.optimal.netProfitEthWei,
        6
      )} | ${r.delta.netProfitEth.toFixed(6)} |`
    );
    md.push(``);

    md.push(`Route attribution (reward token -> WETH)`);
    md.push(``);
    md.push(`Realized:`);
    if (r.routeAttribution.realized.length === 0) md.push(`- (none)`);
    else {
      md.push(`| Token | Sold | WETH In | ETH/Token |`);
      md.push(`| --- | ---: | ---: | ---: |`);
      for (const x of r.routeAttribution.realized) {
        md.push(`| ${x.token} | ${x.soldDec} | ${x.nativeInEth} | ${x.priceEthPerToken} |`);
      }
    }
    md.push(``);
    md.push(`Optimal:`);
    if (r.routeAttribution.optimal.length === 0) md.push(`- (none)`);
    else {
      md.push(`| Token | Sold | WETH In | ETH/Token |`);
      md.push(`| --- | ---: | ---: | ---: |`);
      for (const x of r.routeAttribution.optimal) {
        md.push(`| ${x.token} | ${x.soldDec} | ${x.nativeInEth} | ${x.priceEthPerToken} |`);
      }
    }
    md.push(``);
    md.push(`Artifacts: \`${r.reportPath}\``);
    md.push(``);
  }

  md.push(`## Notes / Limitations`);
  md.push(``);
  md.push(`- Candidate simulations execute harvest as the first tx in the candidate block on a fork (no intra-block ordering vs real txs).`);
  md.push(`- Want pricing uses Curve LP pricing (pool virtual price via the LP token's minter()).`);
  md.push(`- Route attribution uses transfer-log heuristics to assign WETH inflows to the most recently sold reward token.`);
  md.push(``);

  await fs.writeFile(OUT_MD, md.join("\n"));

  process.stdout.write(`Wrote:\n- ${OUT_SUMMARY}\n- ${OUT_MD}\n`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

