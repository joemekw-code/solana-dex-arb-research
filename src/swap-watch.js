#!/usr/bin/env node
/**
 * Swap-event detection via high-frequency polling.
 * Simulates gRPC behavior: detect pool state change → immediately check spread.
 *
 * Method:
 * - Poll Orca 1bp pool account every 200ms (5 RPS, within Helius 10 RPS limit)
 * - When sqrtPrice changes → a swap just happened
 * - Immediately read Raydium + Orca 30bp prices
 * - Record the post-swap spread
 * - This catches the moment BEFORE other bots arbitrage it back
 */

require("dotenv").config();
const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");
const fs = require("fs");

const RPC = process.env.RPC_URL;
const conn = new Connection(RPC, { commitment: "confirmed" });

// Pool addresses
const ORCA_1BP = new PublicKey("83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d"); // SOL/USDC 1bp
const ORCA_30BP = new PublicKey("HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"); // SOL/USDC 30bp
const RAYDIUM = new PublicKey("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"); // SOL/USDC

// Layout offsets
const WP_SQRT = 65; // sqrtPrice u128 at offset 65
const RAY_COIN_VAULT = 336;
const RAY_PC_VAULT = 368;

function readU128(data, offset) { return new BN(data.slice(offset, offset + 16), "le"); }
function readPubkey(data, offset) { return new PublicKey(data.slice(offset, offset + 32)); }
function parseBalance(data) { return new BN(data.slice(64, 72), "le"); }

function sqrtPriceToPrice(sqrtPrice) {
  const Q64 = Math.pow(2, 64);
  const sqrtPF = Number(sqrtPrice.toString()) / Q64;
  return sqrtPF * sqrtPF * 1000; // decimal adjust SOL(9) vs USDC(6)
}

async function getRaydiumPrice() {
  const info = await conn.getAccountInfo(RAYDIUM);
  const coinVault = readPubkey(info.data, RAY_COIN_VAULT);
  const pcVault = readPubkey(info.data, RAY_PC_VAULT);
  const [cv, pv] = await conn.getMultipleAccountsInfo([coinVault, pcVault]);
  const coin = parseBalance(cv.data);
  const pc = parseBalance(pv.data);
  return Number(pc.toString()) / Number(coin.toString()) * 1000; // decimal adjust
}

async function main() {
  console.log("=== SWAP WATCH: Post-swap spread detection ===");
  console.log("Polling Orca 1bp pool every 200ms for state changes");
  console.log("Duration: 30 minutes\n");

  const dataFile = "results/swap-watch.jsonl";
  fs.mkdirSync("results", { recursive: true });

  let lastSqrtPrice = null;
  let swapCount = 0;
  let profitableCount = 0;
  let pollCount = 0;
  const startTime = Date.now();
  const DURATION = 30 * 60 * 1000; // 30 min

  while (Date.now() - startTime < DURATION) {
    pollCount++;

    try {
      // Read Orca 1bp pool (1 RPC call)
      const orca1bpInfo = await conn.getAccountInfo(ORCA_1BP);
      const sqrtPrice = readU128(orca1bpInfo.data, WP_SQRT);
      const orca1bpPrice = sqrtPriceToPrice(sqrtPrice);

      const sqrtStr = sqrtPrice.toString();

      if (lastSqrtPrice !== null && sqrtStr !== lastSqrtPrice) {
        // SWAP DETECTED — price changed!
        swapCount++;
        const swapTime = Date.now();

        // Immediately read other pools (2 more RPC calls)
        const orca30bpInfo = await conn.getAccountInfo(ORCA_30BP);
        const orca30bpSqrt = readU128(orca30bpInfo.data, WP_SQRT);
        const orca30bpPrice = sqrtPriceToPrice(orca30bpSqrt);

        let raydiumPrice;
        try {
          raydiumPrice = await getRaydiumPrice();
        } catch { raydiumPrice = null; }

        const latency = Date.now() - swapTime;

        // Calculate spreads
        const spread_ray_orca1 = raydiumPrice ? Math.abs(raydiumPrice - orca1bpPrice) / Math.min(raydiumPrice, orca1bpPrice) * 100 : null;
        const spread_orca30_orca1 = Math.abs(orca30bpPrice - orca1bpPrice) / Math.min(orca30bpPrice, orca1bpPrice) * 100;

        // Thresholds
        const ray_orca1_threshold = 0.26; // Raydium 0.25% + Orca 1bp 0.01%
        const orca30_orca1_threshold = 0.31; // Orca 30bp 0.3% + Orca 1bp 0.01%

        const ray_profitable = spread_ray_orca1 && spread_ray_orca1 > ray_orca1_threshold;
        const orca_profitable = spread_orca30_orca1 > orca30_orca1_threshold;
        const anyProfitable = ray_profitable || orca_profitable;

        if (anyProfitable) profitableCount++;

        const entry = {
          ts: new Date().toISOString(),
          swap: swapCount,
          latencyMs: latency,
          orca1bp: +orca1bpPrice.toFixed(4),
          orca30bp: +orca30bpPrice.toFixed(4),
          raydium: raydiumPrice ? +raydiumPrice.toFixed(4) : null,
          spread_ray_orca1: spread_ray_orca1 ? +spread_ray_orca1.toFixed(6) : null,
          spread_orca30_orca1: +spread_orca30_orca1.toFixed(6),
          ray_profitable: !!ray_profitable,
          orca_profitable: !!orca_profitable,
        };

        fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");

        const marker = anyProfitable ? " ✓ PROFITABLE" : "";
        console.log(
          `  SWAP #${swapCount} [${latency}ms] orca1bp=$${orca1bpPrice.toFixed(2)} orca30=$${orca30bpPrice.toFixed(2)} ray=$${raydiumPrice?.toFixed(2)||"?"} ` +
          `spread_oo=${spread_orca30_orca1.toFixed(4)}% spread_ro=${spread_ray_orca1?.toFixed(4)||"?"}%${marker}`
        );
      }

      lastSqrtPrice = sqrtStr;

    } catch (e) {
      if (e.message?.includes("429")) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // 200ms interval = 5 RPS (within Helius 10 RPS limit)
    await new Promise(r => setTimeout(r, 200));
  }

  // Final report
  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log("\n" + "=".repeat(50));
  console.log("=== SWAP WATCH RESULTS ===");
  console.log("=".repeat(50));
  console.log(`Duration: ${elapsed} minutes`);
  console.log(`Polls: ${pollCount}`);
  console.log(`Swaps detected: ${swapCount}`);
  console.log(`Profitable post-swap moments: ${profitableCount}`);
  console.log(`Profitable rate: ${swapCount > 0 ? (profitableCount/swapCount*100).toFixed(1) : 0}%`);

  if (profitableCount > 0) {
    const data = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
    const profits = data.filter(d => d.ray_profitable || d.orca_profitable);
    console.log("\nProfitable events:");
    for (const p of profits) {
      console.log(`  ${p.ts} spread_oo=${p.spread_orca30_orca1}% spread_ro=${p.spread_ray_orca1||"?"}%`);
    }
    const perHour = profitableCount / (elapsed / 60);
    console.log(`\nProjected: ${perHour.toFixed(1)} profitable moments/hour`);
    console.log(`At $0.05-0.10 per arb: $${(perHour * 0.075).toFixed(2)}/hour = $${(perHour * 0.075 * 24).toFixed(2)}/day`);
    console.log(`Monthly: $${(perHour * 0.075 * 24 * 30).toFixed(0)} vs gRPC cost $49`);
  } else {
    console.log("\nNo profitable post-swap moments detected.");
    console.log("gRPC may not be worth $49/month for this pair alone.");
    console.log("Consider: more pairs, different tokens, or different approach.");
  }

  console.log(`\nData saved to ${dataFile}`);
}

main().catch(console.error);
