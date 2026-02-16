#!/usr/bin/env node

import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const FORK_RPC_URL = process.env.FORK_RPC_URL ?? "https://mainnet.base.org";
const REALIZED_BLOCK = Number(process.env.REALIZED_BLOCK ?? 0);
const WINDOW_SECONDS = Number(process.env.WINDOW_SECONDS ?? 21600);
const SEARCH_BACKSTOP_BLOCKS = Number(process.env.SEARCH_BACKSTOP_BLOCKS ?? 30000);

if (!REALIZED_BLOCK || Number.isNaN(REALIZED_BLOCK)) {
  console.error("Missing/invalid REALIZED_BLOCK.");
  process.exit(1);
}

if (!WINDOW_SECONDS || Number.isNaN(WINDOW_SECONDS) || WINDOW_SECONDS <= 0) {
  console.error("Missing/invalid WINDOW_SECONDS.");
  process.exit(1);
}

const forkClient = createPublicClient({
  chain: base,
  transport: http(FORK_RPC_URL, { timeout: 120_000 }),
});

async function getTimestamp(blockNumber) {
  const b = await forkClient.getBlock({ blockNumber: BigInt(blockNumber) });
  return Number(b.timestamp);
}

async function run() {
  const realizedTs = await getTimestamp(REALIZED_BLOCK);
  const targetTs = realizedTs - WINDOW_SECONDS;

  // Clamp the search range so we don't binary search from genesis.
  let lo = Math.max(0, REALIZED_BLOCK - SEARCH_BACKSTOP_BLOCKS);
  let hi = REALIZED_BLOCK;

  const loTs = await getTimestamp(lo);
  if (loTs > targetTs) {
    console.error(
      `Backstop too shallow. lo=${lo} has ts=${loTs} > targetTs=${targetTs}. Increase SEARCH_BACKSTOP_BLOCKS.`
    );
    process.exit(1);
  }

  // Find the smallest block with timestamp >= targetTs.
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midTs = await getTimestamp(mid);
    if (midTs >= targetTs) hi = mid;
    else lo = mid;
  }

  process.stdout.write(String(hi));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

