#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  http,
  parseAbi,
  serializeTransaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const CONFIG = {
  strategy: "0x47bA57B0522bdd422B81f7a2e075B2fE1Db3f99B",
  vault: "0xa06C351648dA44078a36c811285ee5eBE74bA089",
  txHash:
    process.env.REALIZED_TX_HASH ??
    "0x1f19267099524175eb02901712c87f07185cd4f422e45f592b469b02b9b33122",
  realizedBlock: Number(process.env.REALIZED_BLOCK ?? 41493767),
  windowStart: Number(process.env.WINDOW_START ?? 41493000),
  windowEnd: Number(process.env.WINDOW_END ?? process.env.REALIZED_BLOCK ?? 41493767),
  step: Number(process.env.STEP ?? 20),
  forkRpcUrl: process.env.FORK_RPC_URL ?? "https://mainnet.base.org",
  anvilRpcUrl: process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545",
  runTag: process.env.RUN_TAG ?? "default",
  gasLimit: BigInt(process.env.GAS_LIMIT ?? 3_000_000),
  senderKey:
    process.env.SIM_SENDER_KEY ??
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";

const strategyAbi = parseAbi([
  "function vault() view returns (address)",
  "function want() view returns (address)",
  "function native() view returns (address)",
  "function beefyFeeConfig() view returns (address)",
  "function curveRouter() view returns (address)",
  "function unirouter() view returns (address)",
  "function rewardPool() view returns (address)",
  "function gauge() view returns (address)",
  "function pid() view returns (uint256)",
  "function curveRewardsLength() view returns (uint256)",
  "function curveReward(uint256 i) view returns (address[11] route, uint256[5][5] swapParams, uint256 minAmount)",
  "function rewardsV3Length() view returns (uint256)",
  "function rewardsV3(uint256 i) view returns (address token, bytes toNativePath, uint256 minAmount)",
  "function callReward() pure returns (uint256)",
  "function harvest()",
  "event ChargedFees(uint256 callFees, uint256 beefyFees, uint256 strategistFees)",
  "event StratHarvest(address indexed harvester, uint256 wantHarvested, uint256 tvl)",
]);

const vaultAbi = parseAbi([
  "function strategy() view returns (address)",
  "function want() view returns (address)",
]);

const curveLpTokenAbi = parseAbi(["function minter() view returns (address)"]);
const curvePoolPriceAbi = parseAbi([
  "function get_virtual_price() view returns (uint256)",
  "function lp_price() view returns (uint256)",
]);

const gasOracleAbi = parseAbi([
  "function getL1Fee(bytes _data) view returns (uint256)",
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const erc20Bytes32Abi = parseAbi(["function symbol() view returns (bytes32)"]);

const account = privateKeyToAccount(CONFIG.senderKey);
const publicClient = createPublicClient({
  chain: base,
  transport: http(CONFIG.anvilRpcUrl, { timeout: 120_000 }),
});
const walletClient = createWalletClient({
  chain: base,
  account,
  transport: http(CONFIG.anvilRpcUrl, { timeout: 120_000 }),
});

const forkClient = createPublicClient({
  chain: base,
  transport: http(CONFIG.forkRpcUrl, { timeout: 120_000 }),
});

function lower(address) {
  return address.toLowerCase();
}

function cleanRoute(route) {
  const out = [];
  for (const addr of route) {
    if (lower(addr) === lower(ZERO_ADDRESS)) continue;
    out.push(addr);
  }
  return out;
}

async function rpc(method, params = []) {
  return publicClient.request({ method, params });
}

async function resetForkForTargetBlock(targetBlock) {
  await rpc("anvil_reset", [
    {
      forking: {
        jsonRpcUrl: CONFIG.forkRpcUrl,
        blockNumber: targetBlock - 1,
      },
    },
  ]);
}

async function resolveCurvePoolFromLpToken(lpTokenAddress) {
  try {
    const minter = await publicClient.readContract({
      address: lpTokenAddress,
      abi: curveLpTokenAbi,
      functionName: "minter",
    });
    if (lower(minter) !== lower(ZERO_ADDRESS)) {
      return { pool: minter, source: "lpToken.minter()" };
    }
  } catch {
    // ignore
  }
  return { pool: lpTokenAddress, source: "lpToken (fallback)" };
}

async function safeReadCurveLpPriceWei(poolAddress) {
  try {
    return {
      priceWei: await publicClient.readContract({
        address: poolAddress,
        abi: curvePoolPriceAbi,
        functionName: "get_virtual_price",
      }),
      method: "get_virtual_price()",
    };
  } catch {
    // ignore
  }

  try {
    return {
      priceWei: await publicClient.readContract({
        address: poolAddress,
        abi: curvePoolPriceAbi,
        functionName: "lp_price",
      }),
      method: "lp_price()",
    };
  } catch {
    // ignore
  }

  return { priceWei: null, method: null };
}

async function safeReadTokenMetadata(token) {
  let symbol = token.slice(0, 6);
  let decimals = 18;

  try {
    symbol = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
      args: [],
    });
  } catch {
    try {
      const raw = await publicClient.readContract({
        address: token,
        abi: erc20Bytes32Abi,
        functionName: "symbol",
        args: [],
      });
      symbol = String(raw).replace(/\u0000/g, "").trim() || symbol;
    } catch {
      // keep fallback
    }
  }

  try {
    decimals = Number(
      await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "decimals",
        args: [],
      })
    );
  } catch {
    // keep fallback
  }

  return { symbol, decimals };
}

function toDecimal(amount, decimals = 18) {
  return Number(formatUnits(amount, decimals));
}

function toBigIntOrNull(value) {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

async function collectStaticStrategyContext() {
  await resetForkForTargetBlock(CONFIG.windowStart);

  const [
    strategyVault,
    strategyWant,
    strategyNative,
    beefyFeeConfig,
    curveRouter,
    unirouter,
    rewardPool,
    gauge,
    pid,
    callReward,
    vaultStrategy,
    vaultWant,
    curveRewardsLength,
    rewardsV3Length,
  ] = await Promise.all([
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "vault",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "want",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "native",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "beefyFeeConfig",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "curveRouter",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "unirouter",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "rewardPool",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "gauge",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "pid",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "callReward",
    }),
    publicClient.readContract({
      address: CONFIG.vault,
      abi: vaultAbi,
      functionName: "strategy",
    }),
    publicClient.readContract({
      address: CONFIG.vault,
      abi: vaultAbi,
      functionName: "want",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "curveRewardsLength",
    }),
    publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "rewardsV3Length",
    }),
  ]);

  const wantPoolInfo = await resolveCurvePoolFromLpToken(strategyWant);

  const curveRewards = [];
  for (let i = 0n; i < curveRewardsLength; i++) {
    const row = await publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "curveReward",
      args: [i],
    });
    const route = row.route ?? row[0];
    const minAmount = row.minAmount ?? row[2];
    curveRewards.push({
      index: Number(i),
      token: route[0],
      minAmount: minAmount.toString(),
      route: cleanRoute(route),
    });
  }

  const rewardsV3 = [];
  for (let i = 0n; i < rewardsV3Length; i++) {
    const row = await publicClient.readContract({
      address: CONFIG.strategy,
      abi: strategyAbi,
      functionName: "rewardsV3",
      args: [i],
    });
    const token = row.token ?? row[0];
    const toNativePath = row.toNativePath ?? row[1];
    const minAmount = row.minAmount ?? row[2];
    rewardsV3.push({
      index: Number(i),
      token,
      minAmount: minAmount.toString(),
      toNativePath,
    });
  }

  return {
    wiring: {
      expectedVault: CONFIG.vault,
      strategyVault,
      expectedStrategy: CONFIG.strategy,
      vaultStrategy,
      strategyWant,
      vaultWant,
      matches: {
        strategyPointsToVault: lower(strategyVault) === lower(CONFIG.vault),
        vaultPointsToStrategy: lower(vaultStrategy) === lower(CONFIG.strategy),
        wantMatches: lower(strategyWant) === lower(vaultWant),
      },
    },
    pricing: {
      wantToken: strategyWant,
      wantPool: wantPoolInfo.pool,
      wantPoolSource: wantPoolInfo.source,
    },
    setup: {
      native: strategyNative,
      beefyFeeConfig,
      curveRouter,
      unirouter,
      rewardPool,
      gauge,
      pid: pid.toString(),
      callReward: callReward.toString(),
      curveRewards,
      rewardsV3,
    },
  };
}

function buildBlockList(start, end, step) {
  const blocks = [];
  for (let b = start; b <= end; b += step) blocks.push(b);
  if (blocks[blocks.length - 1] !== end) blocks.push(end);
  return blocks;
}

function parseReceiptStatus(status) {
  if (status === "success" || status === "reverted") return status;
  if (typeof status === "string") {
    if (status === "0x1") return "success";
    if (status === "0x0") return "reverted";
  }
  return "reverted";
}

function buildHarvestRowFromReceipt({
  targetBlock,
  txHash,
  receipt,
  rewardTokenSet,
  nativeTokenLower,
  wantPricing,
  l1FeeWei,
}) {
  const receiptStatus = parseReceiptStatus(receipt.status);
  if (receiptStatus !== "success") {
    return {
      block: targetBlock,
      simulatedBlock: Number(receipt.blockNumber),
      ok: false,
      txHash,
      error: `reverted: status=${receiptStatus}`,
    };
  }

  let chargedFees = { callFees: 0n, beefyFees: 0n, strategistFees: 0n };
  let stratHarvest = { wantHarvested: 0n, tvl: 0n, harvester: ZERO_ADDRESS };
  const rewardTransfersIn = {};
  const rewardTransfersOut = {};
  let nativeOutTransfers = 0n;
  let nativeInTransfers = 0n;

  // Heuristic attribution: assume swaps execute sequentially per reward token.
  // Attribute native inflows observed after a reward-token outflow to that token until another reward outflow occurs.
  const attributedNativeInByReward = {};
  let currentAttributionTokenLower = null;
  const soldRewardByTokenLower = {};

  for (const log of receipt.logs ?? []) {
    if (lower(log.address) === lower(CONFIG.strategy)) {
      try {
        const parsed = decodeEventLog({
          abi: strategyAbi,
          data: log.data,
          topics: log.topics,
        });
        if (parsed.eventName === "ChargedFees") {
          const args = parsed.args;
          chargedFees = {
            callFees: args.callFees ?? args[0],
            beefyFees: args.beefyFees ?? args[1],
            strategistFees: args.strategistFees ?? args[2],
          };
        }
        if (parsed.eventName === "StratHarvest") {
          const args = parsed.args;
          stratHarvest = {
            harvester: args.harvester ?? args[0],
            wantHarvested: args.wantHarvested ?? args[1],
            tvl: args.tvl ?? args[2],
          };
        }
      } catch {
        // ignore non-matching event signatures
      }
    }

    const tokenLower = lower(log.address);
    try {
      const parsedTransfer = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
      });
      if (parsedTransfer.eventName !== "Transfer") continue;
      const transferArgs = parsedTransfer.args;
      const from = transferArgs.from ?? transferArgs[0];
      const to = transferArgs.to ?? transferArgs[1];
      const value = transferArgs.value ?? transferArgs[2];

      if (
        tokenLower === nativeTokenLower &&
        lower(from) === lower(CONFIG.strategy)
      ) {
        nativeOutTransfers += value;
      }

      if (
        tokenLower === nativeTokenLower &&
        lower(to) === lower(CONFIG.strategy)
      ) {
        nativeInTransfers += value;
        if (currentAttributionTokenLower) {
          attributedNativeInByReward[currentAttributionTokenLower] =
            (attributedNativeInByReward[currentAttributionTokenLower] ?? 0n) +
            value;
        }
      }

      if (
        rewardTokenSet.has(tokenLower) &&
        lower(to) === lower(CONFIG.strategy)
      ) {
        rewardTransfersIn[tokenLower] =
          (rewardTransfersIn[tokenLower] ?? 0n) + value;
      }

      if (
        rewardTokenSet.has(tokenLower) &&
        lower(from) === lower(CONFIG.strategy)
      ) {
        rewardTransfersOut[tokenLower] =
          (rewardTransfersOut[tokenLower] ?? 0n) + value;
        soldRewardByTokenLower[tokenLower] =
          (soldRewardByTokenLower[tokenLower] ?? 0n) + value;

        // Update attribution marker when we observe a reward token being sold.
        if (value > 0n) currentAttributionTokenLower = tokenLower;
      }
    } catch {
      // ignore non-transfer logs
    }
  }

  const grossNativeOut = nativeOutTransfers;
  const totalFeePaid =
    chargedFees.callFees + chargedFees.beefyFees + chargedFees.strategistFees;
  const l2GasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const l1FeeWeiFinal = l1FeeWei ?? 0n;
  const totalGasCostWei = l2GasCostWei + l1FeeWeiFinal;

  const netNativeAfterGas = grossNativeOut - totalGasCostWei;

  const wantHarvested = stratHarvest.wantHarvested;
  const wantPriceWeiFinal = wantPricing?.priceWei ?? 0n;
  const grossProfitEthWei =
    wantPriceWeiFinal > 0n
      ? (wantHarvested * wantPriceWeiFinal) / 10n ** 18n
      : 0n;
  const netProfitEthWei = grossProfitEthWei - totalGasCostWei;
  const netProfitWantWei =
    wantPriceWeiFinal > 0n
      ? wantHarvested - (totalGasCostWei * 10n ** 18n) / wantPriceWeiFinal
      : wantHarvested;

  return {
    block: targetBlock,
    simulatedBlock: Number(receipt.blockNumber),
    ok: true,
    txHash,
    gasUsed: receipt.gasUsed.toString(),
    gasPrice: receipt.effectiveGasPrice.toString(),
    gasCostWei: totalGasCostWei.toString(),
    l2GasCostWei: l2GasCostWei.toString(),
    l1FeeWei: l1FeeWeiFinal.toString(),
    chargedFees: {
      callFees: chargedFees.callFees.toString(),
      beefyFees: chargedFees.beefyFees.toString(),
      strategistFees: chargedFees.strategistFees.toString(),
      totalFeePaid: totalFeePaid.toString(),
    },
    estimated: {
      grossNativeOutWei: grossNativeOut.toString(),
      netNativeAfterGasWei: netNativeAfterGas.toString(),
      keeperCallFeeMinusGasWei: (chargedFees.callFees - totalGasCostWei).toString(),

      // Preferred metric for optimization: want-denominated profit with total (L2 + L1) gas costs included.
      wantPricing: {
        wantToken: wantPricing?.wantToken ?? ZERO_ADDRESS,
        wantPool: wantPricing?.wantPool ?? ZERO_ADDRESS,
        wantPoolSource: wantPricing?.wantPoolSource ?? null,
        priceWei: wantPriceWeiFinal.toString(),
        method: wantPricing?.method ?? null,
      },
      grossProfitWantWei: wantHarvested.toString(),
      grossProfitEthWei: grossProfitEthWei.toString(),
      netProfitWantWei: netProfitWantWei.toString(),
      netProfitEthWei: netProfitEthWei.toString(),

      nativeInWei: nativeInTransfers.toString(),
      nativeOutWei: nativeOutTransfers.toString(),
    },
    stratHarvest: {
      harvester: stratHarvest.harvester,
      wantHarvested: stratHarvest.wantHarvested.toString(),
      tvl: stratHarvest.tvl.toString(),
    },
    rewardTransfersIn,
    rewardTransfersOut,
    swapAttribution: {
      nativeInByReward: Object.fromEntries(
        Object.entries(attributedNativeInByReward).map(([k, v]) => [
          k,
          v.toString(),
        ])
      ),
      rewardSoldByToken: Object.fromEntries(
        Object.entries(soldRewardByTokenLower).map(([k, v]) => [k, v.toString()])
      ),
    },
  };
}

async function simulateBlock(
  targetBlock,
  staticContext,
  rewardTokenSet,
  nativeTokenLower
) {
  await resetForkForTargetBlock(targetBlock);

  const wantPoolAddress =
    staticContext?.pricing?.wantPool ?? staticContext.wiring.strategyWant;
  const { priceWei: wantPriceWei, method: wantPriceMethod } =
    await safeReadCurveLpPriceWei(wantPoolAddress);
  const wantPricing = {
    wantToken: staticContext?.pricing?.wantToken ?? staticContext.wiring.strategyWant,
    wantPool: wantPoolAddress,
    wantPoolSource: staticContext?.pricing?.wantPoolSource ?? null,
    priceWei: wantPriceWei ?? 0n,
    method: wantPriceMethod,
  };

  let txHash;
  try {
    const data = encodeFunctionData({
      abi: strategyAbi,
      functionName: "harvest",
      args: [],
    });
    txHash = await walletClient.sendTransaction({
      to: CONFIG.strategy,
      data,
      gas: CONFIG.gasLimit,
      maxPriorityFeePerGas: 0n,
      maxFeePerGas: 1_000_000_000_000n,
    });
  } catch (error) {
    return {
      block: targetBlock,
      ok: false,
      error: `submit_failed: ${error.shortMessage ?? error.message}`,
    };
  }

  let receipt;
  try {
    // Force a mine so pending tx is executed deterministically on forked anvil.
    await rpc("evm_mine", []);
    receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    return {
      block: targetBlock,
      ok: false,
      txHash,
      error: `receipt_failed: ${error.shortMessage ?? error.message}`,
    };
  }

  if (receipt.status !== "success") {
    return {
      block: targetBlock,
      ok: false,
      txHash,
      simulatedBlock: Number(receipt.blockNumber),
      error: `reverted: status=${receipt.status}`,
    };
  }

  let tx;
  try {
    tx = await publicClient.getTransaction({ hash: txHash });
  } catch {
    tx = null;
  }

  let l1FeeWei = null;
  if (tx) {
    try {
      const serialized = serializeTransaction(
        {
          chainId: tx.chainId,
          type: tx.type,
          nonce: tx.nonce,
          to: tx.to,
          value: tx.value,
          gas: tx.gas,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          gasPrice: tx.gasPrice,
          accessList: tx.accessList,
          data: tx.input,
        },
        {
          r: tx.r,
          s: tx.s,
          v: tx.v,
          yParity: tx.yParity,
        }
      );
      l1FeeWei = await publicClient.readContract({
        address: GAS_PRICE_ORACLE,
        abi: gasOracleAbi,
        functionName: "getL1Fee",
        args: [serialized],
      });
    } catch {
      l1FeeWei = null;
    }
  }

  return buildHarvestRowFromReceipt({
    targetBlock,
    txHash,
    receipt,
    rewardTokenSet,
    nativeTokenLower,
    wantPricing,
    l1FeeWei,
  });
}

async function safeReadCurveLpPriceWeiOnFork(poolAddress, blockNumber) {
  const blockTag =
    typeof blockNumber === "bigint" ? { blockNumber } : undefined;

  try {
    return {
      priceWei: await forkClient.readContract({
        address: poolAddress,
        abi: curvePoolPriceAbi,
        functionName: "get_virtual_price",
        ...(blockTag ?? {}),
      }),
      method: "get_virtual_price()",
    };
  } catch {
    // ignore
  }

  try {
    return {
      priceWei: await forkClient.readContract({
        address: poolAddress,
        abi: curvePoolPriceAbi,
        functionName: "lp_price",
        ...(blockTag ?? {}),
      }),
      method: "lp_price()",
    };
  } catch {
    // ignore
  }

  return { priceWei: null, method: null };
}

async function buildRealizedRowFromForkTx(
  staticContext,
  rewardTokenSet,
  nativeTokenLower
) {
  if (!CONFIG.txHash) throw new Error("Missing REALIZED_TX_HASH / txHash.");

  const rawReceipt = await forkClient.request({
    method: "eth_getTransactionReceipt",
    params: [CONFIG.txHash],
  });
  if (!rawReceipt) throw new Error(`Receipt not found for tx ${CONFIG.txHash}`);

  const receiptBlock = Number(rawReceipt.blockNumber);
  const receipt = {
    blockNumber: BigInt(rawReceipt.blockNumber),
    gasUsed: BigInt(rawReceipt.gasUsed),
    effectiveGasPrice: BigInt(
      rawReceipt.effectiveGasPrice ?? rawReceipt.gasPrice ?? "0x0"
    ),
    status: rawReceipt.status === "0x1" ? "success" : "reverted",
    logs: rawReceipt.logs ?? [],
  };

  let l1FeeWei = null;
  if (rawReceipt.l1Fee) {
    try {
      l1FeeWei = BigInt(rawReceipt.l1Fee);
    } catch {
      l1FeeWei = null;
    }
  }

  if (l1FeeWei === null) {
    try {
      const tx = await forkClient.getTransaction({ hash: CONFIG.txHash });
      const serialized = serializeTransaction(
        {
          chainId: tx.chainId,
          type: tx.type,
          nonce: tx.nonce,
          to: tx.to,
          value: tx.value,
          gas: tx.gas,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          gasPrice: tx.gasPrice,
          accessList: tx.accessList,
          data: tx.input,
        },
        {
          r: tx.r,
          s: tx.s,
          v: tx.v,
          yParity: tx.yParity,
        }
      );
      l1FeeWei = await forkClient.readContract({
        address: GAS_PRICE_ORACLE,
        abi: gasOracleAbi,
        functionName: "getL1Fee",
        args: [serialized],
        blockNumber: receipt.blockNumber,
      });
    } catch {
      l1FeeWei = 0n;
    }
  }

  const wantPoolAddress =
    staticContext?.pricing?.wantPool ?? staticContext.wiring.strategyWant;
  const priceBlock = receipt.blockNumber > 0n ? receipt.blockNumber - 1n : 0n;
  const { priceWei: wantPriceWei, method: wantPriceMethod } =
    await safeReadCurveLpPriceWeiOnFork(wantPoolAddress, priceBlock);

  const wantPricing = {
    wantToken: staticContext?.pricing?.wantToken ?? staticContext.wiring.strategyWant,
    wantPool: wantPoolAddress,
    wantPoolSource: staticContext?.pricing?.wantPoolSource ?? null,
    priceWei: wantPriceWei ?? 0n,
    method: wantPriceMethod,
  };

  return buildHarvestRowFromReceipt({
    targetBlock: receiptBlock,
    txHash: CONFIG.txHash,
    receipt,
    rewardTokenSet,
    nativeTokenLower,
    wantPricing,
    l1FeeWei,
  });
}

function formatNative(wei) {
  return toDecimal(BigInt(wei), 18);
}

function jsonReplacer(_, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function run() {
  console.log("Starting Ghost Audit calibration...");

  const staticContext = await collectStaticStrategyContext();
  const nativeTokenLower = lower(staticContext.setup.native);

  const rewardTokens = new Set();
  for (const item of staticContext.setup.curveRewards) {
    rewardTokens.add(lower(item.token));
  }
  for (const item of staticContext.setup.rewardsV3) {
    rewardTokens.add(lower(item.token));
  }

  const tokenMeta = {};
  tokenMeta[nativeTokenLower] = await safeReadTokenMetadata(
    staticContext.setup.native
  );
  tokenMeta[lower(staticContext.wiring.strategyWant)] = await safeReadTokenMetadata(
    staticContext.wiring.strategyWant
  );
  for (const tokenLower of rewardTokens) {
    tokenMeta[tokenLower] = await safeReadTokenMetadata(tokenLower);
  }

  const blocks = buildBlockList(
    CONFIG.windowStart,
    CONFIG.windowEnd,
    CONFIG.step
  );
  const results = [];
  for (const block of blocks) {
    process.stdout.write(`Simulating block ${block}...\n`);
    const row = await simulateBlock(
      block,
      staticContext,
      rewardTokens,
      nativeTokenLower
    );
    results.push(row);
  }

  const successful = results.filter((r) => r.ok);
  if (successful.length === 0) {
    throw new Error("No successful harvest simulations in window.");
  }

  const scored = successful.map((r) => ({
    block: r.block,
    grossNativeOutWei: BigInt(r.estimated.grossNativeOutWei),
    netNativeAfterGasWei: BigInt(r.estimated.netNativeAfterGasWei),
    netProfitEthWei: BigInt(r.estimated.netProfitEthWei),
    netProfitWantWei: BigInt(r.estimated.netProfitWantWei),
    gasCostWei: BigInt(r.gasCostWei),
    keeperCallFeeMinusGasWei: BigInt(r.estimated.keeperCallFeeMinusGasWei),
    row: r,
  }));

  scored.sort((a, b) =>
    a.netProfitEthWei > b.netProfitEthWei
      ? -1
      : a.netProfitEthWei < b.netProfitEthWei
      ? 1
      : 0
  );

  const optimal = scored[0];
  const realizedSim = scored.find((s) => s.block === CONFIG.realizedBlock) ?? null;
  const realized = await buildRealizedRowFromForkTx(
    staticContext,
    rewardTokens,
    nativeTokenLower
  );

  const realizedNetProfitEthWei = BigInt(realized.estimated.netProfitEthWei);
  const realizedGrossProfitEthWei = BigInt(realized.estimated.grossProfitEthWei);
  const realizedGasCostWei = BigInt(realized.gasCostWei);

  const optimalGrossProfitEthWei = BigInt(optimal.row.estimated.grossProfitEthWei);
  const optimalGasCostWei = BigInt(optimal.row.gasCostWei);

  const deltaNetWei = optimal.netProfitEthWei - realizedNetProfitEthWei;
  const deltaGrossProfitEthWei = optimalGrossProfitEthWei - realizedGrossProfitEthWei;
  const deltaGasWei = optimalGasCostWei - realizedGasCostWei;

  const summary = {
    target: {
      strategy: CONFIG.strategy,
      vault: CONFIG.vault,
      txHash: CONFIG.txHash,
      realizedBlock: CONFIG.realizedBlock,
      windowStart: CONFIG.windowStart,
      windowEnd: CONFIG.windowEnd,
      step: CONFIG.step,
      blocksSimulated: blocks.length,
    },
    strategyValidation: staticContext,
    tokenMeta,
    scoringMetric:
      "netProfitEthWei = (wantHarvested * wantPriceWei / 1e18) - (l2GasCostWei + l1FeeWei)",
    realized,
    realizedSimulated: realizedSim?.row ?? null,
    optimal: optimal.row,
    delta: {
      netProfitEthWei: deltaNetWei.toString(),
      grossProfitEthWei: deltaGrossProfitEthWei.toString(),
      gasCostWei: deltaGasWei.toString(),
      netProfitEth: formatNative(deltaNetWei.toString()),
      grossProfitEth: formatNative(deltaGrossProfitEthWei.toString()),
      gasCostEth: formatNative(deltaGasWei.toString()),
    },
    top5ByNetProfitEth: scored.slice(0, 5).map((s) => ({
      block: s.block,
      netProfitEthWei: s.netProfitEthWei.toString(),
      netProfitEth: formatNative(s.netProfitEthWei.toString()),
      netProfitWantWei: s.netProfitWantWei.toString(),
      grossNativeOutWei: s.grossNativeOutWei.toString(),
      grossNativeOutEth: formatNative(s.grossNativeOutWei.toString()),
      gasCostWei: s.gasCostWei.toString(),
      gasCostEth: formatNative(s.gasCostWei.toString()),
      keeperCallFeeMinusGasWei: s.keeperCallFeeMinusGasWei.toString(),
      keeperCallFeeMinusGasEth: formatNative(
        s.keeperCallFeeMinusGasWei.toString()
      ),
    })),
    rows: results,
  };

  const outDir = path.resolve("reports");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `ghost-audit-${CONFIG.strategy}-${CONFIG.realizedBlock}-${CONFIG.runTag}.json`
  );
  await fs.writeFile(outPath, JSON.stringify(summary, jsonReplacer, 2));

  console.log("");
  console.log("Ghost Audit complete.");
  console.log(`Report: ${outPath}`);
  console.log(
    `Realized net: ${formatNative(realized.estimated.netProfitEthWei)} ETH`
  );
  console.log(
    `Optimal net:  ${formatNative(optimal.row.estimated.netProfitEthWei)} ETH @ block ${optimal.block}`
  );
  console.log(
    `Delta:        ${formatNative(deltaNetWei.toString())} ETH left on table`
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
