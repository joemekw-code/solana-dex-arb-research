#!/usr/bin/env node
/**
 * Two strategies simultaneously:
 *
 * Strategy 1: Find lowest-fee pool pairs
 *   - Orca 1bp ↔ Orca 1bp (different tick spacing) = 0.02% total fee
 *   - Raydium CLMM (0.01%) ↔ Orca 1bp (0.01%) = 0.02% total fee
 *   - Any 0.01% pool ↔ any 0.01% pool = 0.02% threshold
 *
 * Strategy 2: Find high-spread pairs (not just SOL/USDC)
 *   - Tokens with lower liquidity have bigger dislocations
 *   - BONK, WIF, JUP, RAY, etc.
 *
 * Discover ALL Orca Whirlpool pools and Raydium CLMM pools,
 * read prices, find best opportunities.
 */

require("dotenv").config();
const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");
const fs = require("fs");

const RPC = process.env.RPC_URL;
const conn = new Connection(RPC, { commitment: "confirmed" });

function parseBalance(data) { return new BN(data.slice(64, 72), "le"); }
function readU128(data, offset) { return new BN(data.slice(offset, offset + 16), "le"); }
function readU16(data, offset) { return data.readUInt16LE(offset); }
function readPubkey(data, offset) { return new PublicKey(data.slice(offset, offset + 32)); }

const ORCA_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const RAYDIUM_AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

// Known token mints
const TOKENS = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF:  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  RAY:  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
};

const TOKEN_NAMES = {};
for (const [name, mint] of Object.entries(TOKENS)) TOKEN_NAMES[mint] = name;

// ALL known Orca Whirlpool pools (multiple fee tiers per pair)
const ORCA_POOLS = [
  // SOL/USDC
  { id: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ", pair: "SOL/USDC", note: "64ts" },
  { id: "83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d", pair: "SOL/USDC", note: "1ts" },
  { id: "2AWhFp3fHVPAjkD54VBrAvG43FEMheZE2GsuR5A8WNWT", pair: "SOL/USDC", note: "2ts" },
  // SOL/USDT
  { id: "4GkRbcYg1VKsZropgai4dMf2Nj2PkXNLf43knFpavrSi", pair: "SOL/USDT", note: "64ts" },
  // BONK/SOL
  { id: "5sj4wa7BXxbMVjES85RQJSGiVjqM1HJHPz5GLK5aMoJ7", pair: "BONK/SOL", note: "64ts" },
  // WIF/SOL
  { id: "FD32JRgY8Ns5g18HVgDBXCwuQfbEBCPDCbni5xkfXKz2", pair: "WIF/SOL", note: "128ts" },
  // JUP/SOL
  { id: "GgFqj6jyXMLnTuzQEaGT37iMfCUXUbJB6GGT2k3HCFpA", pair: "JUP/SOL", note: "64ts" },
  // JitoSOL/SOL
  { id: "97TdwnhVjmqkBVHMHdxBPsXoFQTXnXiLjMkrRn2TjF5b", pair: "JitoSOL/SOL", note: "2ts" },
  // mSOL/SOL
  { id: "8ApKdXBjRzQz3BcXsYsVoFcTvwVvAMzGBcEmwQ1p3hH3", pair: "mSOL/SOL", note: "1ts" },
];

// Raydium AMM V4 pools
const RAYDIUM_POOLS = [
  { id: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", pair: "SOL/USDC", type: "amm" },
  { id: "7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX", pair: "SOL/USDT", type: "amm" },
];

// Whirlpool layout
const WP = { feeRate: 45, liquidity: 49, sqrtPrice: 65, mintA: 101, mintB: 181 };
// Raydium AMM layout
const RAY = { coinDec: 32, pcDec: 40, feNum: 144, feDen: 152, coinVault: 336, pcVault: 368 };

async function readOrcaPool(poolDef) {
  try {
    const info = await conn.getAccountInfo(new PublicKey(poolDef.id));
    if (!info) return null;
    const data = info.data;
    const feeRate = readU16(data, WP.feeRate);
    const sqrtPrice = readU128(data, WP.sqrtPrice);
    const liquidity = readU128(data, WP.liquidity);
    const mintA = readPubkey(data, WP.mintA).toBase58();
    const mintB = readPubkey(data, WP.mintB).toBase58();

    const Q64 = Math.pow(2, 64);
    const sqrtPF = Number(sqrtPrice.toString()) / Q64;
    const rawPrice = sqrtPF * sqrtPF;

    return {
      ...poolDef, dex: "orca", feeRate, feePct: feeRate / 10000,
      sqrtPrice: sqrtPF, rawPrice, liquidity: liquidity.toString(),
      mintA, mintB, nameA: TOKEN_NAMES[mintA] || mintA.slice(0,6), nameB: TOKEN_NAMES[mintB] || mintB.slice(0,6),
    };
  } catch { return null; }
}

async function readRaydiumPool(poolDef) {
  try {
    const info = await conn.getAccountInfo(new PublicKey(poolDef.id));
    if (!info) return null;
    const data = info.data;
    const coinDec = new BN(data.slice(RAY.coinDec, RAY.coinDec + 8), "le").toNumber();
    const pcDec = new BN(data.slice(RAY.pcDec, RAY.pcDec + 8), "le").toNumber();
    const feeNum = new BN(data.slice(RAY.feNum, RAY.feNum + 8), "le").toNumber();
    const feeDen = new BN(data.slice(RAY.feDen, RAY.feDen + 8), "le").toNumber();
    const coinVault = readPubkey(data, RAY.coinVault);
    const pcVault = readPubkey(data, RAY.pcVault);

    const [cv, pv] = await conn.getMultipleAccountsInfo([coinVault, pcVault]);
    if (!cv || !pv) return null;
    const coinRes = Number(parseBalance(cv.data).toString());
    const pcRes = Number(parseBalance(pv.data).toString());
    const price = pcRes / coinRes;

    return {
      ...poolDef, dex: "raydium", feePct: feeNum / feeDen * 100,
      rawPrice: price, coinDec, pcDec, coinRes, pcRes,
    };
  } catch { return null; }
}

async function main() {
  console.log("=== MULTI-POOL SCAN: Low-fee pairs + High-spread pairs ===\n");
  fs.mkdirSync("results", { recursive: true });
  const dataFile = "results/multi-pool-data.jsonl";

  // Read ALL pools
  console.log("Reading all pools...\n");
  const orcaPools = [];
  for (const p of ORCA_POOLS) {
    const state = await readOrcaPool(p);
    if (state) {
      orcaPools.push(state);
      console.log(`  orca ${state.pair} (${state.note}): fee=${state.feePct.toFixed(2)}% price=${state.rawPrice.toFixed(8)} liq=${state.liquidity.slice(0,8)}...`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  const raydiumPools = [];
  for (const p of RAYDIUM_POOLS) {
    const state = await readRaydiumPool(p);
    if (state) {
      raydiumPools.push(state);
      console.log(`  raydium ${state.pair}: fee=${state.feePct.toFixed(2)}% price=${state.rawPrice.toFixed(8)}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  const allPools = [...orcaPools, ...raydiumPools];
  console.log(`\nTotal pools: ${allPools.length}\n`);

  // Build all cross-pool pairs (same token pair)
  const pairs = [];
  for (let i = 0; i < allPools.length; i++) {
    for (let j = i + 1; j < allPools.length; j++) {
      if (allPools[i].pair === allPools[j].pair) {
        pairs.push([allPools[i], allPools[j]]);
      }
    }
  }

  console.log("Pool pairs found:");
  for (const [a, b] of pairs) {
    const totalFee = a.feePct + b.feePct;
    console.log(`  ${a.pair}: ${a.dex}(${a.feePct.toFixed(2)}%) ↔ ${b.dex}(${b.feePct.toFixed(2)}%) = total ${totalFee.toFixed(2)}%`);
  }

  // Main monitoring loop
  console.log("\n--- Starting monitoring loop (1s interval) ---\n");

  const startTime = Date.now();
  let cycle = 0;
  let profitableCount = 0;

  while (true) {
    cycle++;
    try {
      // Re-read all pools
      const freshPools = [];
      for (const p of ORCA_POOLS) {
        const state = await readOrcaPool(p);
        if (state) freshPools.push(state);
      }
      for (const p of RAYDIUM_POOLS) {
        const state = await readRaydiumPool(p);
        if (state) freshPools.push(state);
      }

      // Check all pairs
      for (let i = 0; i < freshPools.length; i++) {
        for (let j = i + 1; j < freshPools.length; j++) {
          if (freshPools[i].pair !== freshPools[j].pair) continue;

          const a = freshPools[i], b = freshPools[j];

          // Need decimal adjustment for cross-type comparison
          let priceA = a.rawPrice;
          let priceB = b.rawPrice;

          // For Orca CLMM, rawPrice is sqrtP^2 in raw units
          // For Raydium AMM, rawPrice is pcRes/coinRes in raw units
          // Both need decimal adjustment to be comparable
          if (a.dex === "orca" && b.dex === "orca") {
            // Same type, directly comparable
          } else if (a.dex === "raydium" && b.dex === "orca") {
            // Adjust Raydium price: multiply by 10^(coinDec-pcDec) to match Orca raw
            priceA = priceA * Math.pow(10, a.coinDec - a.pcDec);
            priceB = priceB * Math.pow(10, 9 - 6); // assume SOL(9)/USDC(6) for Orca
          } else if (a.dex === "orca" && b.dex === "raydium") {
            priceA = priceA * Math.pow(10, 9 - 6);
            priceB = priceB * Math.pow(10, b.coinDec - b.pcDec);
          }

          const diff = Math.abs(priceA - priceB);
          const diffPct = diff / Math.min(priceA, priceB) * 100;
          const totalFee = a.feePct + b.feePct;
          const netPct = diffPct - totalFee;
          const profitable = netPct > 0;

          if (profitable) profitableCount++;

          const entry = {
            ts: new Date().toISOString(), cycle, pair: a.pair,
            dexA: a.dex, noteA: a.note || "", feeA: a.feePct,
            dexB: b.dex, noteB: b.note || "", feeB: b.feePct,
            diffPct: +diffPct.toFixed(6), totalFee: +totalFee.toFixed(4),
            netPct: +netPct.toFixed(6), profitable,
          };
          fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");

          if (profitable) {
            console.log(`  ✓ PROFITABLE ${a.pair} ${a.dex}(${a.note||""})↔${b.dex}(${b.note||""}): diff=${diffPct.toFixed(4)}% fee=${totalFee.toFixed(2)}% net=${netPct.toFixed(4)}%`);
          }
        }
      }

      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      const lines = fs.readFileSync(dataFile, "utf8").split("\n").length - 1;
      process.stdout.write(`\r  [${elapsed}m] cycle=${cycle} data=${lines} profitable=${profitableCount}   `);

    } catch (e) {
      if (e.message?.includes("429")) await new Promise(r => setTimeout(r, 2000));
    }

    await new Promise(r => setTimeout(r, 1500));
  }
}

main().catch(console.error);
