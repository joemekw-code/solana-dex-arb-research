#!/usr/bin/env node
/**
 * BLIND SPOT TESTS
 *
 * 1. Raydium AMM V4 (NO tick arrays) + Orca Whirlpool atomic simulateTransaction
 * 2. Token-to-token pairs (not through SOL)
 * 3. Extreme sizes ($0.001 and $1000+)
 */

require("dotenv").config();
const { Connection, PublicKey, VersionedTransaction } = require("@solana/web3.js");
const fs = require("fs");

const conn = new Connection(process.env.RPC_URL);
const JUP = "https://lite-api.jup.ag/swap/v1";
const WALLET = "YOUR_WALLET_ADDRESS";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const JUP_TOKEN = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const RAY = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const PYTH = "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3";
const ORCA_TOKEN = "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE";

fs.mkdirSync("results", { recursive: true });
const dataFile = "results/blindspot.jsonl";
const startTime = Date.now();
const DURATION = 15 * 60 * 1000;
let checks = 0, wins = 0;

async function jupQuote(a, b, amt) {
  await new Promise(r => setTimeout(r, 300));
  try {
    const r = await fetch(`${JUP}/quote?inputMint=${a}&outputMint=${b}&amount=${amt}&slippageBps=100`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.outAmount ? d : null;
  } catch { return null; }
}

async function jupQuoteDex(a, b, amt, dexes) {
  await new Promise(r => setTimeout(r, 300));
  try {
    const r = await fetch(`${JUP}/quote?inputMint=${a}&outputMint=${b}&amount=${amt}&slippageBps=100&dexes=${encodeURIComponent(dexes.join(","))}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.outAmount ? d : null;
  } catch { return null; }
}

function log(entry) {
  checks++;
  fs.appendFileSync(dataFile, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n");
  if (entry.profitable) {
    wins++;
    console.log(`\n  ✓ $${entry.net.toFixed(6)} | ${entry.test}: ${entry.detail}`);
  }
}

async function test1_ammVsClmm() {
  console.log("--- Test 1: Raydium AMM V4 vs Orca (direct DEX restriction) ---\n");

  // Raydium (AMM V4 constant product) vs Orca Whirlpool
  // Also: Raydium AMM vs Raydium CLMM (same brand, different pool type)
  const combos = [
    { sell: ["Raydium"], buy: ["Whirlpool"], name: "RayAMM→Orca" },
    { sell: ["Whirlpool"], buy: ["Raydium"], name: "Orca→RayAMM" },
    { sell: ["Raydium"], buy: ["Raydium CLMM"], name: "RayAMM→RayCLMM" },
    { sell: ["Raydium CLMM"], buy: ["Raydium"], name: "RayCLMM→RayAMM" },
    { sell: ["Raydium"], buy: ["Meteora DLMM"], name: "RayAMM→MetDLMM" },
    { sell: ["Meteora DLMM"], buy: ["Raydium"], name: "MetDLMM→RayAMM" },
    { sell: ["Raydium"], buy: ["Raydium CP"], name: "RayAMM→RayCP" },
    { sell: ["Raydium CP"], buy: ["Raydium"], name: "RayCP→RayAMM" },
    { sell: ["Meteora"], buy: ["Whirlpool"], name: "Meteora→Orca" },
    { sell: ["Whirlpool"], buy: ["Meteora"], name: "Orca→Meteora" },
    { sell: ["Meteora DLMM"], buy: ["Whirlpool"], name: "MetDLMM→Orca" },
    { sell: ["Whirlpool"], buy: ["Meteora DLMM"], name: "Orca→MetDLMM" },
  ];

  for (const size of [1000000, 5000000, 10000000, 50000000, 100000000, 500000000, 1000000000]) {
    for (const combo of combos) {
      if (Date.now() - startTime > DURATION) return;

      const q1 = await jupQuoteDex(SOL, USDC, size, combo.sell);
      if (!q1) continue;
      const q2 = await jupQuoteDex(USDC, SOL, q1.outAmount, combo.buy);
      if (!q2) continue;

      const profit = (Number(q2.outAmount) - size) / 1e9 * 89;
      const net = profit - 0.001;
      log({ test: "ammVsClmm", detail: `${combo.name} SOL/USDC @${(size/1e9).toFixed(3)}SOL($${(size/1e9*89).toFixed(0)})`, profit, net, profitable: net > 0 });
    }

    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    process.stdout.write(`\r  [${elapsed}m] ammVsClmm @${(size/1e9).toFixed(3)}SOL checks=${checks} wins=${wins}   `);
  }
}

async function test2_tokenToToken() {
  console.log("\n\n--- Test 2: Token-to-token (no SOL intermediate) ---\n");

  // Test pairs that don't go through SOL
  const pairs = [
    [BONK, WIF], [BONK, JUP_TOKEN], [BONK, PYTH],
    [WIF, JUP_TOKEN], [WIF, RAY], [WIF, ORCA_TOKEN],
    [JUP_TOKEN, RAY], [JUP_TOKEN, PYTH],
    [RAY, ORCA_TOKEN], [RAY, PYTH],
    [BONK, USDT], [WIF, USDT], [JUP_TOKEN, USDT],
    // Also USDC-paired round trips
    [BONK, USDC], [WIF, USDC], [JUP_TOKEN, USDC],
    [RAY, USDC], [PYTH, USDC], [ORCA_TOKEN, USDC],
  ];

  const names = {
    [BONK]: "BONK", [WIF]: "WIF", [JUP_TOKEN]: "JUP", [RAY]: "RAY",
    [PYTH]: "PYTH", [ORCA_TOKEN]: "ORCA", [USDC]: "USDC", [USDT]: "USDT",
  };

  for (const [a, b] of pairs) {
    if (Date.now() - startTime > DURATION) return;

    // Find appropriate amount ($1 worth)
    // Use Jupiter to estimate price
    const priceQ = await jupQuote(a, USDC, "1000000000"); // large amount to get price
    if (!priceQ) continue;

    // Calculate $1 worth
    const pricePerUnit = Number(priceQ.outAmount) / 1e6 / (1000000000 / 1e9);
    if (pricePerUnit <= 0) continue;

    for (const sizeUsd of [1, 5, 10]) {
      const amt = Math.floor((sizeUsd / pricePerUnit) * 1e9); // rough
      if (amt <= 0) continue;

      // Round trip: a → b → a
      const q1 = await jupQuote(a, b, amt);
      if (!q1) continue;
      const q2 = await jupQuote(b, a, q1.outAmount);
      if (!q2) continue;

      const profit = (Number(q2.outAmount) - amt) / amt * sizeUsd;
      const net = profit - 0.001;
      log({ test: "tokenToToken", detail: `${names[a]||"?"}→${names[b]||"?"}→${names[a]||"?"}@$${sizeUsd}`, profit, net, profitable: net > 0 });
    }

    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    process.stdout.write(`\r  [${elapsed}m] t2t: ${names[a]||"?"}/${names[b]||"?"} checks=${checks} wins=${wins}   `);
  }
}

async function test3_extremeSizes() {
  console.log("\n\n--- Test 3: Extreme sizes ($0.001 to $5000 flash swap) ---\n");

  // Very small (rounding errors?) and very large (price impact arb?)
  const sizes = [
    1000, 10000, 100000,           // $0.0001 - $0.01
    1000000, 5000000,               // $0.09 - $0.45
    50000000, 100000000,            // $4.5 - $9
    500000000, 1000000000,          // $45 - $89
    5000000000, 10000000000,        // $445 - $890
    50000000000,                     // $4450 (flash swap)
  ];

  for (const size of sizes) {
    if (Date.now() - startTime > DURATION) return;

    // SOL→USDC→SOL best route
    const q1 = await jupQuote(SOL, USDC, size);
    if (!q1) continue;
    const q2 = await jupQuote(USDC, SOL, q1.outAmount);
    if (!q2) continue;

    const profit = (Number(q2.outAmount) - size) / 1e9 * 89;
    const net = profit - 0.001;
    const solAmt = size / 1e9;
    log({ test: "extremeSize", detail: `SOL→USDC→SOL @${solAmt.toFixed(4)}SOL($${(solAmt*89).toFixed(2)})`, profit, net, profitable: net > 0, routes: `${q1.routePlan?.map(r=>r.swapInfo?.label).join("→")}|${q2.routePlan?.map(r=>r.swapInfo?.label).join("→")}` });

    // Also BONK round-trip at extreme sizes
    const bq1 = await jupQuote(SOL, BONK, size);
    if (!bq1) continue;
    const bq2 = await jupQuote(BONK, SOL, bq1.outAmount);
    if (!bq2) continue;

    const bprofit = (Number(bq2.outAmount) - size) / 1e9 * 89;
    const bnet = bprofit - 0.001;
    log({ test: "extremeSize_bonk", detail: `SOL→BONK→SOL @${solAmt.toFixed(4)}SOL($${(solAmt*89).toFixed(2)})`, profit: bprofit, net: bnet, profitable: bnet > 0 });

    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    process.stdout.write(`\r  [${elapsed}m] extreme @$${(solAmt*89).toFixed(0)} checks=${checks} wins=${wins}   `);
  }
}

async function main() {
  console.log("=== BLIND SPOT TESTS ===\n");

  await test1_ammVsClmm();
  if (Date.now() - startTime < DURATION) await test2_tokenToToken();
  if (Date.now() - startTime < DURATION) await test3_extremeSizes();

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log("\n\n" + "=".repeat(50));
  console.log(`BLIND SPOT RESULTS: ${elapsed}m | ${checks} checks`);
  console.log(`Profitable: ${wins}`);

  const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
  const sorted = lines.sort((a, b) => b.net - a.net);

  if (wins > 0) {
    console.log("\n=== PROFITABLE ===");
    for (const e of sorted.filter(l => l.profitable)) console.log(`  $${e.net.toFixed(6)} | ${e.test}: ${e.detail}`);
  }

  console.log("\nClosest (top 15):");
  for (const e of sorted.slice(0, 15)) console.log(`  $${e.net?.toFixed(6)} | ${e.test}: ${e.detail}`);
  console.log("\nSaved to results/blindspot.jsonl");
}

main().catch(console.error);
