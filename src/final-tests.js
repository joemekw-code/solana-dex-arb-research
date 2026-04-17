#!/usr/bin/env node
/**
 * FINAL UNTESTED METHODS — 3 parallel strategies
 *
 * 1. New tokens (recently created Raydium/Orca pools)
 * 2. Minor DEXes (Manifest, Bonkswap, ZeroFi, HumidiFi, GoonFi, Quantum)
 * 3. Event-driven: monitor for swaps, check immediately after
 */

const fs = require("fs");
require("dotenv").config();
const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");

const conn = new Connection(process.env.RPC_URL);
const JUP = "https://lite-api.jup.ag/swap/v1";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let apiCalls = 0;
let lastCall = 0;
async function jupQuote(inputMint, outputMint, amount, dexes = null) {
  const wait = Math.max(0, lastCall + 300 - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  apiCalls++;
  try {
    let url = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=200`;
    if (dexes) url += `&dexes=${encodeURIComponent(dexes.join(","))}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    return d.outAmount ? { out: d.outAmount, route: d.routePlan?.map(r => r.swapInfo?.label).join("→") || "?" } : null;
  } catch { return null; }
}

fs.mkdirSync("results", { recursive: true });
const dataFile = "results/final-tests.jsonl";
const startTime = Date.now();
const DURATION = 15 * 60 * 1000;
let totalChecks = 0;
let profitableCount = 0;

function logR(entry) {
  fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");
  totalChecks++;
  if (entry.profitable) {
    profitableCount++;
    console.log(`\n  ✓ $${entry.net.toFixed(4)} | ${entry.method}: ${entry.detail}`);
  }
}

// ═══ TEST 1: Find new tokens via Jupiter token API ═══
async function test1_newTokens() {
  console.log("--- Test 1: New/trending tokens ---\n");

  // Get trending tokens from Jupiter
  let tokens = [];
  try {
    const res = await fetch("https://tokens.jup.ag/tokens?sortBy=volume24hUSD&limit=100");
    const all = await res.json();
    // Skip top 20 (too efficient), take 21-100 (less efficient, more opportunity)
    tokens = all.slice(20, 80).filter(t => t.daily_volume > 10000);
    console.log(`  Found ${tokens.length} mid-tier tokens`);
  } catch (e) {
    console.log("  Token API failed:", e.message?.slice(0, 50));
    return;
  }

  for (const token of tokens) {
    if (Date.now() - startTime > DURATION) break;

    const amt = Math.floor(1e9 / 89); // ~$0.01 SOL worth... no, let's do $1
    const solAmt = Math.floor((1 / 89) * 1e9); // $1 of SOL

    // Best route sell: token → SOL
    const tokenAmt = Math.floor((1 / (token.price || 0.001)) * Math.pow(10, token.decimals));
    if (tokenAmt <= 0 || !token.price) continue;

    // Strategy: SOL → token → SOL (round trip)
    const q1 = await jupQuote(SOL, token.address, solAmt);
    if (!q1) continue;
    const q2 = await jupQuote(token.address, SOL, q1.out);
    if (!q2) continue;

    const profit = (Number(q2.out) - solAmt) / 1e9 * 89;
    const net = profit - 0.001;

    logR({
      method: "newToken", detail: `SOL→${token.symbol}→SOL@$1 [${q1.route}|${q2.route}]`,
      profit, net, profitable: net > 0, symbol: token.symbol,
    });

    if (totalChecks % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      process.stdout.write(`\r  [${elapsed}m] newTokens: ${token.symbol} checks=${totalChecks} wins=${profitableCount}   `);
    }
  }
}

// ═══ TEST 2: Minor DEXes with BONK (closest to profit) ═══
async function test2_minorDexes() {
  console.log("\n--- Test 2: Minor DEXes (BONK was closest) ---\n");

  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

  // All DEXes including minor ones
  const allDexes = [
    "Raydium CLMM", "Raydium CP", "Raydium",
    "Whirlpool", "Meteora", "Meteora DLMM",
    "Phoenix", "Lifinity V2", "OpenBook V2",
    "Manifest", "Bonkswap", "ZeroFi", "HumidiFi",
    "GoonFi V2", "Quantum", "PancakeSwap",
  ];

  const tokens = [
    { sym: "BONK", mint: BONK, dec: 5, price: 0.000018 },
    { sym: "WIF", mint: WIF, dec: 6, price: 0.21 },
  ];

  for (const token of tokens) {
    for (const sizeUsd of [1, 5, 10, 50]) {
      const solAmt = Math.floor((sizeUsd / 89) * 1e9);

      for (const dex1 of allDexes) {
        if (Date.now() - startTime > DURATION) return;

        // Sell SOL for token on dex1
        const q1 = await jupQuote(SOL, token.mint, solAmt, [dex1]);
        if (!q1) continue;

        // Buy SOL back via Jupiter best route
        const q2 = await jupQuote(token.mint, SOL, q1.out);
        if (!q2) continue;

        const profit = (Number(q2.out) - solAmt) / 1e9 * 89;
        const net = profit - 0.001;
        logR({
          method: "minorDex", detail: `SOL→${token.sym}(${dex1})→SOL(best)@$${sizeUsd} [${q1.route}|${q2.route}]`,
          profit, net, profitable: net > 0,
        });
      }

      // Reverse: best route sell, single dex buy back
      const bestSell = await jupQuote(SOL, token.mint, solAmt);
      if (!bestSell) continue;

      for (const dex2 of allDexes) {
        if (Date.now() - startTime > DURATION) return;
        const q2 = await jupQuote(token.mint, SOL, bestSell.out, [dex2]);
        if (!q2) continue;
        const profit = (Number(q2.out) - solAmt) / 1e9 * 89;
        const net = profit - 0.001;
        logR({
          method: "minorDex_rev", detail: `SOL→${token.sym}(best)→SOL(${dex2})@$${sizeUsd} [${bestSell.route}|${q2.route}]`,
          profit, net, profitable: net > 0,
        });
      }

      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      process.stdout.write(`\r  [${elapsed}m] minorDex: ${token.sym}@$${sizeUsd} checks=${totalChecks} wins=${profitableCount}   `);
    }
  }
}

// ═══ TEST 3: Event-driven with Jupiter API ═══
async function test3_eventDriven() {
  console.log("\n--- Test 3: Event-driven (watch for swaps) ---\n");

  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  // Watch the Orca BONK/SOL pool for swaps
  const ORCA_BONK_SOL = new PublicKey("5sj4wa7BXxbMVjES85RQJSGiVjqM1HJHPz5GLK5aMoJ7");

  let lastSqrtPrice = null;
  const endTime = startTime + DURATION;

  while (Date.now() < endTime) {
    try {
      // Check pool state
      const info = await conn.getAccountInfo(ORCA_BONK_SOL);
      if (!info) { await new Promise(r => setTimeout(r, 1000)); continue; }

      const sqrtPrice = new BN(info.data.slice(65, 81), "le").toString();

      if (lastSqrtPrice && sqrtPrice !== lastSqrtPrice) {
        // SWAP DETECTED! Check arb immediately
        const solAmt = Math.floor((5 / 89) * 1e9); // $5

        // SOL → BONK → SOL round trip
        const q1 = await jupQuote(SOL, BONK, solAmt);
        if (q1) {
          const q2 = await jupQuote(BONK, SOL, q1.out);
          if (q2) {
            const profit = (Number(q2.out) - solAmt) / 1e9 * 89;
            const net = profit - 0.001;
            logR({
              method: "eventDriven", detail: `BONK swap detected! SOL→BONK→SOL@$5 [${q1.route}|${q2.route}]`,
              profit, net, profitable: net > 0,
            });
          }
        }
      }

      lastSqrtPrice = sqrtPrice;
    } catch {}

    await new Promise(r => setTimeout(r, 500));
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    process.stdout.write(`\r  [${elapsed}m] eventDriven: watching BONK/SOL checks=${totalChecks} wins=${profitableCount}   `);
  }
}

async function main() {
  console.log("=== FINAL UNTESTED METHODS ===\n");

  await test1_newTokens();
  if (Date.now() - startTime < DURATION) await test2_minorDexes();
  if (Date.now() - startTime < DURATION) await test3_eventDriven();

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log("\n\n" + "=".repeat(50));
  console.log(`Duration: ${elapsed}m | Checks: ${totalChecks} | API calls: ${apiCalls}`);
  console.log(`Profitable: ${profitableCount}`);

  if (profitableCount > 0) {
    const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const profits = lines.filter(l => l.profitable).sort((a, b) => b.net - a.net);
    console.log("\n=== PROFITABLE ===");
    for (const p of profits) console.log(`  $${p.net.toFixed(4)} | ${p.method}: ${p.detail}`);
  } else {
    const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const sorted = lines.sort((a, b) => b.net - a.net);
    console.log("\nClosest (top 10):");
    for (const e of sorted.slice(0, 10)) console.log(`  $${e.net.toFixed(6)} | ${e.method}: ${e.detail}`);
  }
  console.log("\nSaved to results/final-tests.jsonl");
}

main().catch(console.error);
