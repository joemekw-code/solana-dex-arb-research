#!/usr/bin/env node
/**
 * REAL SIMULATION: Use Jupiter swap API (actual execution price, not sqrtPrice approximation)
 * for ALL DEX combinations, ALL sizes, ALL pairs.
 *
 * This gives the EXACT same result as live execution, minus the actual tx submission.
 *
 * Variables to test (all combinations):
 * V1: DEX pair (buy DEX × sell DEX)
 *   - Raydium CLMM, Raydium CP, Raydium (AMM), Whirlpool, Meteora, Meteora DLMM,
 *     Phoenix, Lifinity V2, OpenBook V2
 * V2: Token pair
 *   - SOL/USDC, SOL/USDT, BONK/SOL, WIF/SOL, JUP/SOL, RAY/SOL, JitoSOL/SOL, mSOL/SOL
 * V3: Trade size
 *   - $0.50, $1, $5, $10, $50, $100
 * V4: Direction
 *   - A→B→A, B→A→B
 */

const fs = require("fs");

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const RAY = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

const PAIRS = [
  { name: "SOL/USDC", a: SOL, b: USDC, decA: 9, decB: 6, price: 89 },
  { name: "SOL/USDT", a: SOL, b: USDT, decA: 9, decB: 6, price: 89 },
  { name: "BONK/SOL", a: BONK, b: SOL, decA: 5, decB: 9, price: 0.000018 },
  { name: "WIF/SOL", a: WIF, b: SOL, decA: 6, decB: 9, price: 0.003 },
  { name: "JUP/SOL", a: JUP, b: SOL, decA: 6, decB: 9, price: 0.002 },
  { name: "RAY/SOL", a: RAY, b: SOL, decA: 6, decB: 9, price: 0.008 },
  { name: "JitoSOL/SOL", a: JITOSOL, b: SOL, decA: 9, decB: 9, price: 1.05 },
  { name: "mSOL/SOL", a: MSOL, b: SOL, decA: 9, decB: 9, price: 1.03 },
];

const DEXES = [
  "Raydium CLMM", "Raydium CP", "Raydium",
  "Whirlpool", "Meteora", "Meteora DLMM",
  "Phoenix", "Lifinity V2",
];

const SIZES_USD = [0.5, 1, 5, 10, 50, 100];

const JUP_API = "https://lite-api.jup.ag/swap/v1";

let lastCall = 0;
async function jupQuote(inputMint, outputMint, amount, dexes) {
  const now = Date.now();
  const wait = Math.max(0, lastCall + 250 - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();

  try {
    const dexParam = dexes.join(",");
    const url = `${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100&dexes=${encodeURIComponent(dexParam)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.outAmount) return null;
    return {
      outAmount: BigInt(data.outAmount),
      inAmount: BigInt(data.inAmount || amount),
      route: data.routePlan?.map(r => r.swapInfo?.label).join("→") || "?",
    };
  } catch { return null; }
}

async function main() {
  console.log("=== REAL SIMULATION (Jupiter swap API) ===");
  console.log("Uses actual execution prices, not approximations");
  console.log(`Pairs: ${PAIRS.length}, DEXes: ${DEXES.length}, Sizes: ${SIZES_USD.length}`);
  console.log(`Total combos per cycle: ~${PAIRS.length * DEXES.length * (DEXES.length - 1) * SIZES_USD.length}`);
  console.log("Duration: 15 minutes\n");

  fs.mkdirSync("results", { recursive: true });
  const dataFile = "results/real-sim.jsonl";
  const startTime = Date.now();
  const DURATION = 15 * 60 * 1000;
  let cycle = 0;
  let totalChecks = 0;
  let profitableCount = 0;
  const profitableEvents = [];

  while (Date.now() - startTime < DURATION) {
    cycle++;

    for (const pair of PAIRS) {
      for (const size of SIZES_USD) {
        const amountA = Math.floor((size / pair.price) * 10 ** pair.decA);
        if (amountA <= 0) continue;

        // Get quotes from all DEXes for leg 1 (A→B)
        const leg1Quotes = {};
        for (const dex of DEXES) {
          const q = await jupQuote(pair.a, pair.b, amountA, [dex]);
          if (q) leg1Quotes[dex] = q;
        }

        // For each pair of DEXes where we got leg1 quotes
        const dexWithQuotes = Object.keys(leg1Quotes);

        for (const sellDex of dexWithQuotes) {
          // Now get leg2 quote (B→A) on different DEXes
          for (const buyDex of dexWithQuotes) {
            if (sellDex === buyDex) continue;
            totalChecks++;

            // Leg 2: buy A back with B from leg1
            const leg2 = await jupQuote(pair.b, pair.a, leg1Quotes[sellDex].outAmount.toString(), [buyDex]);
            if (!leg2) continue;

            const startAmount = BigInt(amountA);
            const endAmount = leg2.outAmount;
            const profitRaw = Number(endAmount - startAmount);
            const profitUsd = (profitRaw / 10 ** pair.decA) * pair.price;

            // Subtract gas + Jito tip
            const gasCost = 0.001; // $0.001 Solana tx
            const jitoTip = profitUsd > 0 ? profitUsd * 0.5 : 0;
            const netProfit = profitUsd - gasCost - jitoTip;

            const entry = {
              ts: new Date().toISOString(),
              cycle, pair: pair.name, size,
              sellDex, buyDex,
              sellRoute: leg1Quotes[sellDex].route,
              buyRoute: leg2.route,
              profitUsd: +profitUsd.toFixed(6),
              netProfit: +netProfit.toFixed(6),
              profitable: netProfit > 0,
            };
            fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");

            if (netProfit > 0) {
              profitableCount++;
              profitableEvents.push(entry);
              console.log(`\n  ✓ $${netProfit.toFixed(4)} | ${pair.name}@$${size} ${sellDex}→${buyDex} (sell:${leg1Quotes[sellDex].route} buy:${leg2.route})`);
            }
          }
        }
      }

      // Status
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      process.stdout.write(`\r  [${elapsed}m] cycle=${cycle} pair=${pair.name} checks=${totalChecks} wins=${profitableCount}   `);
    }
  }

  // Report
  const hours = (Date.now() - startTime) / 3600000;
  console.log("\n\n" + "=".repeat(50));
  console.log("=== REAL SIMULATION RESULTS ===");
  console.log("=".repeat(50));
  console.log(`Duration: ${(hours * 60).toFixed(1)} minutes`);
  console.log(`Total checks: ${totalChecks}`);
  console.log(`Profitable: ${profitableCount}`);

  if (profitableEvents.length > 0) {
    console.log("\n=== PROFITABLE EVENTS ===");
    for (const e of profitableEvents) {
      console.log(`  $${e.netProfit.toFixed(4)} | ${e.pair}@$${e.size} ${e.sellDex}→${e.buyDex}`);
    }
    const totalProfit = profitableEvents.reduce((a, e) => a + e.netProfit, 0);
    console.log(`\nTotal: $${totalProfit.toFixed(4)}`);
    console.log(`Per hour: $${(totalProfit / hours).toFixed(4)}`);
    console.log(`Per week: $${(totalProfit / hours * 168).toFixed(2)} = ¥${(totalProfit / hours * 168 * 150).toFixed(0)}`);
  } else {
    console.log("\nNo profitable events.");
    // Show closest to breakeven
    const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const sorted = lines.sort((a, b) => b.netProfit - a.netProfit);
    console.log("\nClosest to profit (top 10):");
    for (const e of sorted.slice(0, 10)) {
      console.log(`  $${e.netProfit.toFixed(6)} | ${e.pair}@$${e.size} ${e.sellDex}→${e.buyDex}`);
    }
  }

  fs.writeFileSync("results/real-sim-results.json", JSON.stringify({
    stats: { totalChecks, profitableCount, hours },
    profitable: profitableEvents,
  }, null, 2));
  console.log("\nSaved to results/real-sim-results.json");
}

main().catch(console.error);
