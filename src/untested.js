#!/usr/bin/env node
/**
 * ALL UNTESTED DEX-DEX ARB METHODS — parallel execution
 *
 * 1. Triangular routes (A→B→C→A) via Jupiter
 * 2. Same-DEX different pool type (Raydium AMM vs Raydium CLMM)
 * 3. Tiny/new tokens with bigger mispricings
 * 4. LST round-trip (JitoSOL→SOL→mSOL→JitoSOL)
 * 5. USDC↔USDT stablecoin arb across DEXes
 * 6. Larger token universe (50+ tokens)
 * 7. Different size sweet spots (micro $0.10 to macro $1000)
 * 8. Jupiter best-route vs single-DEX comparison
 */

const fs = require("fs");

const JUP = "https://lite-api.jup.ag/swap/v1";

const TOKENS = {
  SOL:     { mint: "So11111111111111111111111111111111111111112", dec: 9, price: 89 },
  USDC:    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", dec: 6, price: 1 },
  USDT:    { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", dec: 6, price: 1 },
  JitoSOL: { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", dec: 9, price: 93 },
  mSOL:    { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", dec: 9, price: 92 },
  bSOL:    { mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", dec: 9, price: 91 },
  BONK:    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", dec: 5, price: 0.000018 },
  WIF:     { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", dec: 6, price: 0.21 },
  JUPTOKEN:{ mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", dec: 6, price: 0.17 },
  RAY:     { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", dec: 6, price: 0.68 },
  PYTH:    { mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", dec: 6, price: 0.13 },
  ORCA:    { mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", dec: 6, price: 0.8 },
  RENDER:  { mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", dec: 8, price: 2.8 },
  HNT:     { mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", dec: 8, price: 3.5 },
  W:       { mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ", dec: 6, price: 0.09 },
};

const DEXES = [
  "Raydium CLMM", "Raydium CP", "Raydium",
  "Whirlpool", "Meteora", "Meteora DLMM",
  "Phoenix", "Lifinity V2", "OpenBook V2",
];

let callCount = 0;
async function jupQuote(inputMint, outputMint, amount, dexes = null) {
  callCount++;
  // Rate limit: max 4 calls/sec
  await new Promise(r => setTimeout(r, 250));
  try {
    let url = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100`;
    if (dexes) url += `&dexes=${encodeURIComponent(dexes.join(","))}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    return d.outAmount ? { out: BigInt(d.outAmount), route: d.routePlan?.map(r => r.swapInfo?.label).join("→") || "?" } : null;
  } catch { return null; }
}

fs.mkdirSync("results", { recursive: true });
const dataFile = "results/untested.jsonl";
const startTime = Date.now();
const DURATION = 15 * 60 * 1000;
let profitableCount = 0;
let totalChecks = 0;

function log(entry) {
  fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");
  totalChecks++;
  if (entry.profitable) {
    profitableCount++;
    console.log(`\n  ✓ $${entry.netProfit.toFixed(4)} | ${entry.test} ${entry.detail}`);
  }
}

async function test1_triangular() {
  // A→B→C→A triangular routes
  const triangles = [
    ["SOL", "USDC", "USDT"],
    ["SOL", "USDC", "JUPTOKEN"],
    ["SOL", "USDC", "RAY"],
    ["SOL", "USDC", "BONK"],
    ["SOL", "USDC", "WIF"],
    ["SOL", "USDT", "USDC"],
    ["SOL", "BONK", "USDC"],
    ["SOL", "WIF", "USDC"],
    ["SOL", "JitoSOL", "USDC"],
    ["SOL", "mSOL", "USDC"],
    ["USDC", "USDT", "SOL"],
    ["USDC", "SOL", "BONK"],
    ["SOL", "PYTH", "USDC"],
    ["SOL", "ORCA", "USDC"],
    ["SOL", "RENDER", "USDC"],
  ];

  for (const [a, b, c] of triangles) {
    if (Date.now() - startTime > DURATION) return;
    const tA = TOKENS[a], tB = TOKENS[b], tC = TOKENS[c];
    if (!tA || !tB || !tC) continue;

    for (const sizeUsd of [1, 5, 10]) {
      const amtA = Math.floor((sizeUsd / tA.price) * 10 ** tA.dec);

      const q1 = await jupQuote(tA.mint, tB.mint, amtA);
      if (!q1) continue;
      const q2 = await jupQuote(tB.mint, tC.mint, q1.out.toString());
      if (!q2) continue;
      const q3 = await jupQuote(tC.mint, tA.mint, q2.out.toString());
      if (!q3) continue;

      const profit = Number(q3.out - BigInt(amtA)) / 10 ** tA.dec * tA.price;
      const net = profit - 0.001;
      log({ test: "triangular", detail: `${a}→${b}→${c}→${a}@$${sizeUsd}`, profitUsd: profit, netProfit: net, profitable: net > 0, route: `${q1.route}|${q2.route}|${q3.route}` });
    }
  }
}

async function test2_sameDexDiffPool() {
  // Raydium AMM vs Raydium CLMM vs Raydium CP
  const rayTypes = ["Raydium", "Raydium CLMM", "Raydium CP"];
  for (let i = 0; i < rayTypes.length; i++) {
    for (let j = i + 1; j < rayTypes.length; j++) {
      if (Date.now() - startTime > DURATION) return;
      for (const sizeUsd of [1, 5, 10]) {
        const amt = Math.floor((sizeUsd / 89) * 1e9);
        const q1 = await jupQuote(TOKENS.SOL.mint, TOKENS.USDC.mint, amt, [rayTypes[i]]);
        if (!q1) continue;
        const q2 = await jupQuote(TOKENS.USDC.mint, TOKENS.SOL.mint, q1.out.toString(), [rayTypes[j]]);
        if (!q2) continue;
        const profit = Number(q2.out - BigInt(amt)) / 1e9 * 89;
        const net = profit - 0.001;
        log({ test: "sameDex", detail: `${rayTypes[i]}→${rayTypes[j]}@$${sizeUsd}`, profitUsd: profit, netProfit: net, profitable: net > 0 });
      }
    }
  }
}

async function test3_newTokens() {
  // Smaller tokens with potential bigger mispricings
  const pairs = [
    ["BONK", "USDC"], ["WIF", "USDC"], ["JUPTOKEN", "USDC"],
    ["PYTH", "USDC"], ["W", "USDC"], ["RAY", "USDC"],
    ["ORCA", "USDC"], ["HNT", "USDC"], ["RENDER", "USDC"],
    ["BONK", "SOL"], ["WIF", "SOL"], ["JUPTOKEN", "SOL"],
  ];

  for (const [a, b] of pairs) {
    if (Date.now() - startTime > DURATION) return;
    const tA = TOKENS[a], tB = TOKENS[b];
    if (!tA || !tB) continue;

    for (const sizeUsd of [0.5, 1, 5]) {
      const amt = Math.floor((sizeUsd / tA.price) * 10 ** tA.dec);
      if (amt <= 0) continue;

      // Test all DEX pairs
      for (const dex1 of DEXES) {
        for (const dex2 of DEXES) {
          if (dex1 === dex2) continue;
          if (Date.now() - startTime > DURATION) return;

          const q1 = await jupQuote(tA.mint, tB.mint, amt, [dex1]);
          if (!q1) continue;
          const q2 = await jupQuote(tB.mint, tA.mint, q1.out.toString(), [dex2]);
          if (!q2) continue;

          const profit = Number(q2.out - BigInt(amt)) / 10 ** tA.dec * tA.price;
          const net = profit - 0.001;
          log({ test: "newToken", detail: `${a}/${b} ${dex1}→${dex2}@$${sizeUsd}`, profitUsd: profit, netProfit: net, profitable: net > 0 });
        }
      }
    }
  }
}

async function test4_lstRoundTrip() {
  // LST circular: JitoSOL→SOL→mSOL→SOL→bSOL→SOL→JitoSOL
  const lsts = ["JitoSOL", "mSOL", "bSOL"];
  for (let i = 0; i < lsts.length; i++) {
    for (let j = 0; j < lsts.length; j++) {
      if (i === j) continue;
      if (Date.now() - startTime > DURATION) return;
      const a = lsts[i], b = lsts[j];
      const tA = TOKENS[a];
      for (const sizeUsd of [5, 10, 50]) {
        const amt = Math.floor((sizeUsd / tA.price) * 10 ** tA.dec);
        // a → SOL → b → SOL → a
        const q1 = await jupQuote(tA.mint, TOKENS.SOL.mint, amt);
        if (!q1) continue;
        const q2 = await jupQuote(TOKENS.SOL.mint, TOKENS[b].mint, q1.out.toString());
        if (!q2) continue;
        const q3 = await jupQuote(TOKENS[b].mint, TOKENS.SOL.mint, q2.out.toString());
        if (!q3) continue;
        const q4 = await jupQuote(TOKENS.SOL.mint, tA.mint, q3.out.toString());
        if (!q4) continue;

        const profit = Number(q4.out - BigInt(amt)) / 10 ** tA.dec * tA.price;
        const net = profit - 0.002; // 4 swaps = 2x gas
        log({ test: "lstCircular", detail: `${a}→SOL→${b}→SOL→${a}@$${sizeUsd}`, profitUsd: profit, netProfit: net, profitable: net > 0 });
      }
    }
  }
}

async function test5_stablecoinArb() {
  // USDC↔USDT across different DEXes
  for (const dex1 of DEXES) {
    for (const dex2 of DEXES) {
      if (dex1 === dex2) continue;
      if (Date.now() - startTime > DURATION) return;
      for (const size of [10, 50, 100, 500]) {
        const amt = size * 1e6;
        const q1 = await jupQuote(TOKENS.USDC.mint, TOKENS.USDT.mint, amt, [dex1]);
        if (!q1) continue;
        const q2 = await jupQuote(TOKENS.USDT.mint, TOKENS.USDC.mint, q1.out.toString(), [dex2]);
        if (!q2) continue;
        const profit = (Number(q2.out) - amt) / 1e6;
        const net = profit - 0.001;
        log({ test: "stablecoin", detail: `USDC→USDT→USDC ${dex1}→${dex2}@$${size}`, profitUsd: profit, netProfit: net, profitable: net > 0 });
      }
    }
  }
}

async function test6_jupiterBestVsSingle() {
  // Jupiter best route vs restricted single-DEX: if Jupiter finds a better route,
  // the difference is the arb opportunity
  for (const [name, token] of Object.entries(TOKENS)) {
    if (name === "SOL" || name === "USDC") continue;
    if (Date.now() - startTime > DURATION) return;

    const amt = Math.floor((5 / token.price) * 10 ** token.dec);
    if (amt <= 0) continue;

    // Jupiter best route
    const best = await jupQuote(token.mint, TOKENS.USDC.mint, amt);
    if (!best) continue;

    // Each single DEX
    for (const dex of DEXES) {
      const single = await jupQuote(token.mint, TOKENS.USDC.mint, amt, [dex]);
      if (!single) continue;

      const diff = Number(best.out - single.out) / 1e6;
      const diffPct = diff / (Number(single.out) / 1e6) * 100;

      if (diffPct > 0.1) {
        log({ test: "bestVsSingle", detail: `${name}/USDC Jupiter(${best.route}) vs ${dex}(${single.route})`, diffUsd: diff, diffPct, profitable: false, netProfit: -1 });
        // This shows WHERE price is worse = potential arb target
      }
    }
  }
}

async function main() {
  console.log("=== ALL UNTESTED METHODS — 15min parallel ===\n");

  // Run all tests sequentially (rate limited by Jupiter API)
  // but covering maximum diversity

  const tests = [
    { name: "1. Triangular", fn: test1_triangular },
    { name: "2. Same-DEX diff pool", fn: test2_sameDexDiffPool },
    { name: "3. New/small tokens", fn: test3_newTokens },
    { name: "4. LST circular", fn: test4_lstRoundTrip },
    { name: "5. Stablecoin arb", fn: test5_stablecoinArb },
    { name: "6. Best vs single DEX", fn: test6_jupiterBestVsSingle },
  ];

  for (const test of tests) {
    if (Date.now() - startTime > DURATION) break;
    console.log(`\n--- ${test.name} ---`);
    await test.fn();
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log(`  [${elapsed}m] checks=${totalChecks} wins=${profitableCount}`);
  }

  // Final report
  const hours = (Date.now() - startTime) / 3600000;
  console.log("\n" + "=".repeat(50));
  console.log("=== FINAL RESULTS ===");
  console.log(`Duration: ${(hours * 60).toFixed(1)}m | Checks: ${totalChecks} | API calls: ${callCount}`);
  console.log(`Profitable: ${profitableCount}`);

  if (profitableCount > 0) {
    const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const profits = lines.filter(l => l.profitable).sort((a, b) => b.netProfit - a.netProfit);
    console.log("\n=== PROFITABLE ===");
    for (const p of profits) {
      console.log(`  $${p.netProfit.toFixed(4)} | ${p.test}: ${p.detail}`);
    }
  } else {
    const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const sorted = lines.sort((a, b) => b.netProfit - a.netProfit);
    console.log("\nClosest to profit:");
    for (const e of sorted.slice(0, 15)) {
      console.log(`  $${e.netProfit.toFixed(6)} | ${e.test}: ${e.detail}`);
    }
  }

  console.log("\nSaved to results/untested.jsonl");
}

main().catch(console.error);
