#!/usr/bin/env node
/**
 * MASSIVE TEST: Focus on the untested areas with smart rate limiting.
 *
 * Previously failed: small token × DEX combos (47/2592 due to rate limit)
 * Fix: batch quotes efficiently, prioritize most promising combos
 *
 * Strategy:
 * 1. For each token pair: get Jupiter BEST route quote (1 call)
 * 2. Get single-DEX quotes for buy-back leg (1 call each)
 * 3. If best_route_out > single_dex_buy_back → profit exists
 * 4. This halves API calls: N DEXes per pair instead of N×N
 *
 * Also test:
 * - 4-hop routes
 * - Larger sizes ($50-$500) where price impact creates reverse arb
 * - New/trending tokens from Jupiter token list
 */

const fs = require("fs");

const JUP = "https://lite-api.jup.ag/swap/v1";

// Rate limiter: 4 calls/sec max
let lastCall = 0;
let apiCalls = 0;
async function jupQuote(inputMint, outputMint, amount, dexes = null) {
  const wait = Math.max(0, lastCall + 260 - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  apiCalls++;
  try {
    let url = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100`;
    if (dexes) url += `&dexes=${encodeURIComponent(dexes.join(","))}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    return d.outAmount ? { out: d.outAmount, route: d.routePlan?.map(r => r.swapInfo?.label).join("→") || "?" } : null;
  } catch { return null; }
}

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const DEXES = [
  "Raydium CLMM", "Raydium CP", "Raydium",
  "Whirlpool", "Meteora", "Meteora DLMM",
  "Phoenix", "Lifinity V2",
];

// Expanded token list — 30+ tokens
const TOKENS = [
  { sym: "SOL", mint: SOL, dec: 9, price: 89 },
  { sym: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", dec: 5, price: 0.000018 },
  { sym: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", dec: 6, price: 0.21 },
  { sym: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", dec: 6, price: 0.17 },
  { sym: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", dec: 6, price: 0.68 },
  { sym: "PYTH", mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", dec: 6, price: 0.13 },
  { sym: "ORCA", mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", dec: 6, price: 0.8 },
  { sym: "JTO", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", dec: 9, price: 1.5 },
  { sym: "RENDER", mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", dec: 8, price: 2.8 },
  { sym: "HNT", mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", dec: 8, price: 3.5 },
  { sym: "W", mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ", dec: 6, price: 0.09 },
  { sym: "DRIFT", mint: "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7", dec: 6, price: 0.3 },
  { sym: "POPCAT", mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", dec: 9, price: 0.15 },
  { sym: "MEW", mint: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", dec: 5, price: 0.002 },
  { sym: "KMNO", mint: "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS", dec: 6, price: 0.03 },
  { sym: "TNSR", mint: "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6", dec: 9, price: 0.2 },
  { sym: "JitoSOL", mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", dec: 9, price: 93 },
  { sym: "mSOL", mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", dec: 9, price: 92 },
];

fs.mkdirSync("results", { recursive: true });
const dataFile = "results/massive-test.jsonl";
const startTime = Date.now();
const DURATION = 15 * 60 * 1000;
let totalChecks = 0;
let profitableCount = 0;

function logResult(entry) {
  fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");
  totalChecks++;
  if (entry.profitable) {
    profitableCount++;
    console.log(`\n  ✓ $${entry.net.toFixed(4)} | ${entry.method} ${entry.detail}`);
  }
}

async function main() {
  console.log("=== MASSIVE TEST: 30+ tokens × 8 DEXes × multiple methods ===\n");

  // ═══ METHOD 1: Smart 2-point arb ═══
  // For each token: sell on Jupiter best route, buy back on each single DEX
  console.log("--- Method 1: Best route sell → Single DEX buy back ---\n");

  for (const token of TOKENS) {
    if (Date.now() - startTime > DURATION) break;
    if (token.sym === "SOL") continue; // base token

    for (const sizeUsd of [1, 5, 10, 50]) {
      if (Date.now() - startTime > DURATION) break;
      const amt = Math.floor((sizeUsd / token.price) * 10 ** token.dec);
      if (amt <= 0) continue;

      // Sell token for SOL via Jupiter best route
      const sell = await jupQuote(token.mint, SOL, amt);
      if (!sell) continue;

      // Buy token back on each DEX
      for (const dex of DEXES) {
        if (Date.now() - startTime > DURATION) break;
        const buy = await jupQuote(SOL, token.mint, sell.out, [dex]);
        if (!buy) continue;

        const profit = (Number(BigInt(buy.out) - BigInt(amt))) / 10 ** token.dec * token.price;
        const net = profit - 0.001;
        logResult({
          method: "smart2pt", detail: `${token.sym} best(${sell.route})→${dex}(${buy.route})@$${sizeUsd}`,
          profit, net, profitable: net > 0,
        });
      }

      // Also: sell on each DEX, buy back via best route
      for (const dex of DEXES) {
        if (Date.now() - startTime > DURATION) break;
        const sellSingle = await jupQuote(token.mint, SOL, amt, [dex]);
        if (!sellSingle) continue;

        const buyBest = await jupQuote(SOL, token.mint, sellSingle.out);
        if (!buyBest) continue;

        const profit = (Number(BigInt(buyBest.out) - BigInt(amt))) / 10 ** token.dec * token.price;
        const net = profit - 0.001;
        logResult({
          method: "smart2pt_rev", detail: `${token.sym} ${dex}(${sellSingle.route})→best(${buyBest.route})@$${sizeUsd}`,
          profit, net, profitable: net > 0,
        });
      }
    }

    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    process.stdout.write(`\r  [${elapsed}m] ${token.sym} done | checks=${totalChecks} wins=${profitableCount} calls=${apiCalls}   `);
  }

  // ═══ METHOD 2: Triangular with all token combos ═══
  console.log("\n\n--- Method 2: Expanded triangular ---\n");

  const triTokens = TOKENS.filter(t => t.sym !== "SOL").slice(0, 10);
  for (let i = 0; i < triTokens.length; i++) {
    for (let j = i + 1; j < triTokens.length; j++) {
      if (Date.now() - startTime > DURATION) break;
      const a = triTokens[i], b = triTokens[j];

      // SOL → A → B → SOL
      const amt = Math.floor((5 / 89) * 1e9); // $5 of SOL
      const q1 = await jupQuote(SOL, a.mint, amt);
      if (!q1) continue;
      const q2 = await jupQuote(a.mint, b.mint, q1.out);
      if (!q2) continue;
      const q3 = await jupQuote(b.mint, SOL, q2.out);
      if (!q3) continue;

      const profit = (Number(q3.out) - amt) / 1e9 * 89;
      const net = profit - 0.001;
      logResult({
        method: "tri_expanded", detail: `SOL→${a.sym}→${b.sym}→SOL@$5`,
        profit, net, profitable: net > 0,
      });
    }
  }

  // ═══ METHOD 3: 4-hop routes ═══
  console.log("\n--- Method 3: 4-hop routes ---\n");

  const hop4 = [
    ["SOL", "BONK", "USDC", "WIF", "SOL"],
    ["SOL", "JUP", "USDC", "BONK", "SOL"],
    ["SOL", "BONK", "WIF", "USDC", "SOL"],
    ["SOL", "RAY", "USDC", "BONK", "SOL"],
    ["SOL", "JitoSOL", "USDC", "mSOL", "SOL"],
    ["SOL", "PYTH", "USDC", "JUP", "SOL"],
    ["SOL", "WIF", "BONK", "USDC", "SOL"],
    ["SOL", "ORCA", "USDC", "RAY", "SOL"],
  ];

  for (const route of hop4) {
    if (Date.now() - startTime > DURATION) break;
    const mints = route.map(sym => TOKENS.find(t => t.sym === sym) || { mint: sym === "USDC" ? USDC : sym === "USDT" ? USDT : "" });
    const amt = Math.floor((5 / 89) * 1e9);

    let current = amt.toString();
    let failed = false;
    const legs = [];
    for (let i = 0; i < route.length - 1; i++) {
      const q = await jupQuote(mints[i].mint || TOKENS.find(t=>t.sym===route[i])?.mint, mints[i+1].mint || TOKENS.find(t=>t.sym===route[i+1])?.mint, current);
      if (!q) { failed = true; break; }
      current = q.out;
      legs.push(q.route);
    }
    if (failed) continue;

    const profit = (Number(current) - amt) / 1e9 * 89;
    const net = profit - 0.002; // 4 swaps = extra gas
    logResult({
      method: "4hop", detail: `${route.join("→")}@$5 [${legs.join("|")}]`,
      profit, net, profitable: net > 0,
    });
  }

  // ═══ METHOD 4: Large size reverse impact ═══
  console.log("\n--- Method 4: Large size ($100-$500) reverse impact ---\n");

  for (const token of TOKENS.slice(1, 8)) {
    if (Date.now() - startTime > DURATION) break;
    for (const sizeUsd of [100, 250, 500]) {
      const amt = Math.floor((sizeUsd / token.price) * 10 ** token.dec);
      if (amt <= 0) continue;

      // Large sell creates price impact → buy back cheap on different DEX
      const sell = await jupQuote(token.mint, SOL, amt);
      if (!sell) continue;

      for (const dex of DEXES.slice(0, 4)) { // top 4 DEXes only for speed
        const buy = await jupQuote(SOL, token.mint, sell.out, [dex]);
        if (!buy) continue;
        const profit = (Number(BigInt(buy.out) - BigInt(amt))) / 10 ** token.dec * token.price;
        const net = profit - 0.001;
        logResult({
          method: "largeSize", detail: `${token.sym} best→${dex}@$${sizeUsd}`,
          profit, net, profitable: net > 0,
        });
      }
    }
  }

  // ═══ FINAL REPORT ═══
  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log("\n\n" + "=".repeat(50));
  console.log("=== MASSIVE TEST RESULTS ===");
  console.log(`Duration: ${elapsed}m | Checks: ${totalChecks} | API calls: ${apiCalls}`);
  console.log(`Profitable: ${profitableCount}`);

  if (profitableCount > 0) {
    const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const profits = lines.filter(l => l.profitable).sort((a, b) => b.net - a.net);
    console.log("\n=== ALL PROFITABLE ===");
    for (const p of profits) {
      console.log(`  $${p.net.toFixed(4)} | ${p.method}: ${p.detail}`);
    }
  } else {
    const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const sorted = lines.sort((a, b) => b.net - a.net);
    console.log("\nClosest to profit (top 15):");
    for (const e of sorted.slice(0, 15)) {
      console.log(`  $${e.net.toFixed(6)} | ${e.method}: ${e.detail}`);
    }
  }

  console.log("\nSaved to results/massive-test.jsonl");
}

main().catch(console.error);
