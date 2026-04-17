#!/usr/bin/env node
/**
 * Maximum data collection: use all 10 RPS from Helius free plan.
 * Read ALL available pool pairs, record price diffs every 1 second.
 * Goal: 3000+ data points by 7:00 AM.
 *
 * Pools: Raydium AMM × Orca Whirlpool for every shared pair.
 * Also: multiple Raydium pools for same pair (different liquidity).
 */

require("dotenv").config();
const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");
const fs = require("fs");

const RPC = process.env.RPC_URL;
const conn = new Connection(RPC, { commitment: "confirmed" });

// SPL Token balance parser
function parseBalance(data) { return new BN(data.slice(64, 72), "le"); }
function readU128(data, offset) { return new BN(data.slice(offset, offset + 16), "le"); }
function readU16(data, offset) { return data.readUInt16LE(offset); }
function readPubkey(data, offset) { return new PublicKey(data.slice(offset, offset + 32)); }

// ═══ All known SOL/USDC pools across DEXes ═══
const POOLS = [
  // Raydium AMM V4
  { id: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", dex: "raydium", pair: "SOL/USDC", type: "amm" },
  // Raydium SOL/USDT
  { id: "7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX", dex: "raydium", pair: "SOL/USDT", type: "amm" },
  // Raydium RAY/SOL
  { id: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA", dex: "raydium", pair: "RAY/SOL", type: "amm" },
  // Raydium RAY/USDC
  { id: "6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg", dex: "raydium", pair: "RAY/USDC", type: "amm" },
  // Orca SOL/USDC Whirlpool
  { id: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ", dex: "orca", pair: "SOL/USDC", type: "clmm" },
  // Orca SOL/USDC (different tick spacing - 1bp pool)
  { id: "83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d", dex: "orca_1bp", pair: "SOL/USDC", type: "clmm" },
  // Orca SOL/USDT
  { id: "4GkRbcYg1VKsZropgai4dMf2Nj2PkXNLf43knFpavrSi", dex: "orca", pair: "SOL/USDT", type: "clmm" },
];

// Raydium AMM layout offsets
const RAY = { coinDec: 32, pcDec: 40, feNum: 144, feDen: 152, coinVault: 336, pcVault: 368, coinMint: 400, pcMint: 432 };

// Orca Whirlpool layout offsets
const WP = { feeRate: 45, liquidity: 49, sqrtPrice: 65, tickIdx: 81, mintA: 101, vaultA: 133, mintB: 181, vaultB: 213 };

async function readPool(poolDef) {
  const pubkey = new PublicKey(poolDef.id);
  const info = await conn.getAccountInfo(pubkey);
  if (!info) return null;
  const data = info.data;

  if (poolDef.type === "amm") {
    const coinVault = readPubkey(data, RAY.coinVault);
    const pcVault = readPubkey(data, RAY.pcVault);
    const coinDec = new BN(data.slice(RAY.coinDec, RAY.coinDec + 8), "le").toNumber();
    const pcDec = new BN(data.slice(RAY.pcDec, RAY.pcDec + 8), "le").toNumber();
    const feeNum = new BN(data.slice(RAY.feNum, RAY.feNum + 8), "le").toNumber();
    const feeDen = new BN(data.slice(RAY.feDen, RAY.feDen + 8), "le").toNumber();

    const [cvInfo, pvInfo] = await conn.getMultipleAccountsInfo([coinVault, pcVault]);
    if (!cvInfo || !pvInfo) return null;

    const coinRes = parseBalance(cvInfo.data);
    const pcRes = parseBalance(pvInfo.data);
    const price = Number(pcRes.toString()) / Number(coinRes.toString()) * Math.pow(10, coinDec - pcDec);
    const feePct = feeNum / feeDen * 100;

    return { ...poolDef, price, coinRes: coinRes.toString(), pcRes: pcRes.toString(), coinDec, pcDec, feePct };
  }

  if (poolDef.type === "clmm") {
    const sqrtPrice = readU128(data, WP.sqrtPrice);
    const liquidity = readU128(data, WP.liquidity);
    const feeRate = readU16(data, WP.feeRate);
    const Q64 = Math.pow(2, 64);
    const sqrtPF = Number(sqrtPrice.toString()) / Q64;

    // Assume SOL(9dec)/USDC(6dec) for these pools
    const decAdj = Math.pow(10, 9 - 6); // = 1000
    const price = sqrtPF * sqrtPF * decAdj;
    const feePct = feeRate / 10000; // feeRate is in 1e-6, convert to %

    return { ...poolDef, price, sqrtPrice: sqrtPrice.toString(), liquidity: liquidity.toString(), feePct };
  }

  return null;
}

async function main() {
  console.log("=== MAX DATA COLLECTION ===");
  console.log(`Pools: ${POOLS.length}`);
  console.log(`RPC: Helius (10 RPS limit)`);
  console.log(`Interval: 2s (5 RPS used per cycle)`);
  console.log();

  const dataFile = "results/max-price-data.jsonl";
  fs.mkdirSync("results", { recursive: true });

  let cycle = 0;
  const startTime = Date.now();

  while (true) {
    cycle++;
    const ts = new Date().toISOString();

    try {
      // Read all pools in parallel (batch of 3 to stay under 10 RPS)
      const results = [];
      for (let i = 0; i < POOLS.length; i += 3) {
        const batch = POOLS.slice(i, i + 3);
        const batchResults = await Promise.allSettled(batch.map(p => readPool(p)));
        for (const r of batchResults) {
          if (r.status === "fulfilled" && r.value) results.push(r.value);
        }
      }

      // Group by pair, compute all pairwise diffs
      const byPair = {};
      for (const r of results) {
        if (!byPair[r.pair]) byPair[r.pair] = [];
        byPair[r.pair].push(r);
      }

      for (const [pair, pools] of Object.entries(byPair)) {
        for (let i = 0; i < pools.length; i++) {
          for (let j = i + 1; j < pools.length; j++) {
            const a = pools[i], b = pools[j];
            const diff = Math.abs(a.price - b.price);
            const diffPct = diff / Math.min(a.price, b.price) * 100;
            const totalFee = a.feePct + b.feePct;
            const netPct = diffPct - totalFee;
            const profitable = netPct > 0;

            const dataPoint = {
              ts, cycle, pair,
              dexA: a.dex, priceA: a.price, feeA: a.feePct,
              dexB: b.dex, priceB: b.price, feeB: b.feePct,
              diffPct: +diffPct.toFixed(6),
              totalFee: +totalFee.toFixed(4),
              netPct: +netPct.toFixed(6),
              profitable,
            };

            fs.appendFileSync(dataFile, JSON.stringify(dataPoint) + "\n");

            if (profitable) {
              console.log(`  ✓ ${pair} ${a.dex}↔${b.dex}: diff=${diffPct.toFixed(4)}% fee=${totalFee.toFixed(2)}% net=${netPct.toFixed(4)}%`);
            }
          }
        }
      }

      // Status
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      const lines = fs.readFileSync(dataFile, "utf8").split("\n").length - 1;
      const profits = fs.readFileSync(dataFile, "utf8").split("\n").filter(l => l.includes('"profitable":true')).length;
      process.stdout.write(`\r  [${elapsed}m] cycle=${cycle} datapoints=${lines} profitable=${profits}   `);

    } catch (e) {
      if (e.message?.includes("429")) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    await new Promise(r => setTimeout(r, 1000)); // 2s interval
  }
}

main().catch(console.error);
