#!/usr/bin/env node
/**
 * BRUTE FORCE: Test EVERYTHING we haven't tested.
 * Run multiple strategies in parallel using Promise.allSettled.
 * 15 minutes, maximum throughput.
 *
 * NEW approaches not yet tested:
 * 1. Jupiter swap tx → simulateTransaction (actual on-chain result)
 * 2. Cross-chain: Solana SOL price vs Arbitrum SOL price (via Jupiter + Uniswap)
 * 3. Trending/new tokens from Jupiter API (retry with error handling)
 * 4. USDC→token→USDT→SOL 4-hop (different intermediate)
 * 5. Flash swap: borrow SOL from one pool, arb, repay (atomic simulation)
 * 6. Different slippage settings (0 vs 50 vs 200 bps)
 * 7. Larger universe: top 200 tokens
 * 8. Time-series: check same pair every 2s for 15 min (catch transient spikes)
 */

require("dotenv").config();
const { Connection, PublicKey, VersionedTransaction } = require("@solana/web3.js");
const fs = require("fs");

const conn = new Connection(process.env.RPC_URL);
const JUP = "https://lite-api.jup.ag/swap/v1";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WALLET = "YOUR_WALLET_ADDRESS";

fs.mkdirSync("results", { recursive: true });
const dataFile = "results/brute.jsonl";
const startTime = Date.now();
const DURATION = 15 * 60 * 1000;
let checks = 0, wins = 0, apiCalls = 0;

async function jupQuote(a, b, amt, slippage = 100) {
  apiCalls++;
  try {
    const r = await fetch(`${JUP}/quote?inputMint=${a}&outputMint=${b}&amount=${amt}&slippageBps=${slippage}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.outAmount ? d : null;
  } catch { return null; }
}

async function jupSwapTx(quoteResponse) {
  apiCalls++;
  try {
    const r = await fetch(`${JUP}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteResponse, userPublicKey: WALLET, wrapAndUnwrapSol: true }),
    });
    const d = await r.json();
    return d.swapTransaction || null;
  } catch { return null; }
}

function log(entry) {
  checks++;
  fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");
  if (entry.profitable) {
    wins++;
    console.log(`\n  ✓ $${entry.net.toFixed(6)} | ${entry.method}: ${entry.detail}`);
  }
}

// === STRATEGY 1: simulateTransaction round-trip ===
async function strat1_simulate() {
  console.log("  [S1] simulateTransaction round-trip");
  const amt = Math.floor(0.01 * 1e9);

  // Get quote + swap tx for leg 1
  const q1 = await jupQuote(SOL, BONK, amt);
  if (!q1) return;
  const tx1base64 = await jupSwapTx(q1);
  if (!tx1base64) return;

  // Simulate leg 1
  const tx1 = VersionedTransaction.deserialize(Buffer.from(tx1base64, "base64"));
  const sim1 = await conn.simulateTransaction(tx1, { sigVerify: false });

  if (sim1.value.err) {
    log({ method: "simulate", detail: "leg1 failed: " + JSON.stringify(sim1.value.err), net: -1, profitable: false });
    return;
  }

  // Check post-simulation balances from logs
  const logs = sim1.value.logs || [];
  log({ method: "simulate", detail: `leg1 OK, ${sim1.value.unitsConsumed} CU, logs=${logs.length}`, net: -0.001, profitable: false });
}

// === STRATEGY 2: Top 200 tokens round-trip ===
async function strat2_topTokens() {
  console.log("  [S2] Top 200 tokens");

  let tokens = [];
  try {
    // Try multiple token list endpoints
    const r = await fetch("https://token.jup.ag/strict");
    tokens = await r.json();
    tokens = tokens.filter(t => t.daily_volume > 5000).slice(0, 200);
  } catch {
    try {
      const r = await fetch("https://tokens.jup.ag/tokens?sortBy=volume24hUSD&limit=200");
      tokens = await r.json();
    } catch { return; }
  }

  console.log(`    Found ${tokens.length} tokens`);

  for (const token of tokens) {
    if (Date.now() - startTime > DURATION) break;
    if (token.address === SOL || token.address === USDC || token.address === USDT) continue;

    const amt = Math.floor(0.01 * 1e9); // $0.89 of SOL
    await new Promise(r => setTimeout(r, 300));

    const q1 = await jupQuote(SOL, token.address, amt);
    if (!q1) continue;
    await new Promise(r => setTimeout(r, 300));

    const q2 = await jupQuote(token.address, SOL, q1.outAmount);
    if (!q2) continue;

    const profit = (Number(q2.outAmount) - amt) / 1e9 * 89;
    const net = profit - 0.001;
    log({ method: "top200", detail: `SOL→${token.symbol}→SOL@$0.89`, profit, net, profitable: net > 0 });

    if (checks % 20 === 0) {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      process.stdout.write(`\r    [${elapsed}m] ${token.symbol} checks=${checks} wins=${wins} api=${apiCalls}   `);
    }
  }
}

// === STRATEGY 3: Different slippage (0bps = exact) ===
async function strat3_zeroSlippage() {
  console.log("\n  [S3] Zero slippage quotes");

  const tokens = [BONK, "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"];
  const amt = Math.floor(0.05 * 1e9);

  for (const token of tokens) {
    for (const slip of [0, 10, 50]) {
      if (Date.now() - startTime > DURATION) return;
      await new Promise(r => setTimeout(r, 300));

      const q1 = await jupQuote(SOL, token, amt, slip);
      if (!q1) continue;
      await new Promise(r => setTimeout(r, 300));

      const q2 = await jupQuote(token, SOL, q1.outAmount, slip);
      if (!q2) continue;

      const profit = (Number(q2.outAmount) - amt) / 1e9 * 89;
      const net = profit - 0.001;
      log({ method: "slippage", detail: `SOL→${token.slice(0,6)}→SOL slip=${slip}bps`, profit, net, profitable: net > 0 });
    }
  }
}

// === STRATEGY 4: Rapid time-series (same pair, catch transients) ===
async function strat4_timeSeries() {
  console.log("\n  [S4] Time-series: SOL→BONK→SOL every 2s");
  const amt = Math.floor(0.05 * 1e9);
  const endTime = Math.min(startTime + DURATION, Date.now() + 5 * 60 * 1000); // max 5 min

  while (Date.now() < endTime) {
    const q1 = await jupQuote(SOL, BONK, amt);
    if (!q1) { await new Promise(r => setTimeout(r, 1000)); continue; }
    const q2 = await jupQuote(BONK, SOL, q1.outAmount);
    if (!q2) { await new Promise(r => setTimeout(r, 1000)); continue; }

    const profit = (Number(q2.outAmount) - amt) / 1e9 * 89;
    const net = profit - 0.001;
    log({ method: "timeseries", detail: `SOL→BONK→SOL@$4.45`, profit, net, profitable: net > 0 });

    await new Promise(r => setTimeout(r, 2000));
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    process.stdout.write(`\r    [${elapsed}m] timeseries checks=${checks} wins=${wins} best=$${profit.toFixed(6)}   `);
  }
}

// === STRATEGY 5: 4-hop with USDT intermediate ===
async function strat5_fourHop() {
  console.log("\n  [S5] 4-hop with USDT");
  const routes = [
    [SOL, BONK, USDT, USDC, SOL],
    [SOL, USDC, BONK, USDT, SOL],
    [SOL, USDT, BONK, USDC, SOL],
    [SOL, "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", USDC, USDT, SOL], // WIF
    [SOL, "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", USDT, USDC, SOL], // JUP
  ];

  for (const route of routes) {
    if (Date.now() - startTime > DURATION) return;
    let current = Math.floor(0.01 * 1e9).toString();
    let ok = true;

    for (let i = 0; i < route.length - 1; i++) {
      await new Promise(r => setTimeout(r, 300));
      const q = await jupQuote(route[i], route[i+1], current);
      if (!q) { ok = false; break; }
      current = q.outAmount;
    }
    if (!ok) continue;

    const profit = (Number(current) - Math.floor(0.01 * 1e9)) / 1e9 * 89;
    const net = profit - 0.002;
    log({ method: "4hop_usdt", detail: route.map(m => m.slice(0,4)).join("→"), profit, net, profitable: net > 0 });
  }
}

async function main() {
  console.log("=== BRUTE FORCE: 15 min max throughput ===\n");

  await strat1_simulate();
  await strat2_topTokens();
  if (Date.now() - startTime < DURATION) await strat3_zeroSlippage();
  if (Date.now() - startTime < DURATION) await strat5_fourHop();
  if (Date.now() - startTime < DURATION) await strat4_timeSeries();

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log("\n\n" + "=".repeat(50));
  console.log(`BRUTE FORCE RESULTS: ${elapsed}m | ${checks} checks | ${apiCalls} API calls`);
  console.log(`Profitable: ${wins}`);

  if (wins > 0) {
    const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const p = lines.filter(l => l.profitable).sort((a, b) => b.net - a.net);
    for (const e of p) console.log(`  $${e.net.toFixed(6)} | ${e.method}: ${e.detail}`);
  } else {
    const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const sorted = lines.filter(l => l.net !== undefined).sort((a, b) => b.net - a.net);
    console.log("\nClosest:");
    for (const e of sorted.slice(0, 10)) console.log(`  $${e.net?.toFixed(6)} | ${e.method}: ${e.detail}`);
  }
}

main().catch(console.error);
