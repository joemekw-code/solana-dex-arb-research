#!/usr/bin/env node
/**
 * GOLDEN PAIR: Raydium CLMM 0.01% ↔ Orca Whirlpool 0.01% (SOL/USDC)
 * Total fee: 0.02%. Current spread: 0.20%. Net profit: 0.18%.
 *
 * Continuously monitor and record real data.
 * This is the pair to build the arb bot around.
 */

require("dotenv").config();
const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");
const fs = require("fs");

const conn = new Connection(process.env.RPC_URL, { commitment: "confirmed" });

const RAYDIUM_CLMM = new PublicKey("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj");
const ORCA_1BP = new PublicKey("83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d");
const Q64 = Math.pow(2, 64);
const FEE_TOTAL = 0.02; // 0.01% + 0.01%

fs.mkdirSync("results", { recursive: true });
const dataFile = "results/golden-pair.jsonl";
const startTime = Date.now();
let cycle = 0;
let profitableCount = 0;
let totalNetProfit = 0;

async function readPrices() {
  const [rayInfo, orcaInfo] = await conn.getMultipleAccountsInfo([RAYDIUM_CLMM, ORCA_1BP]);
  if (!rayInfo || !orcaInfo) return null;

  const raySqrt = Number(new BN(rayInfo.data.slice(253, 269), "le").toString()) / Q64;
  const orcaSqrt = Number(new BN(orcaInfo.data.slice(65, 81), "le").toString()) / Q64;

  return {
    rayPrice: raySqrt * raySqrt * 1000,
    orcaPrice: orcaSqrt * orcaSqrt * 1000,
  };
}

async function main() {
  console.log("=== GOLDEN PAIR MONITOR ===");
  console.log("Raydium CLMM 0.01% ↔ Orca Whirlpool 0.01%");
  console.log("Total fee: 0.02% — any spread > 0.02% = profit\n");

  while (true) {
    cycle++;
    try {
      const prices = await readPrices();
      if (!prices) { await new Promise(r => setTimeout(r, 1000)); continue; }

      const { rayPrice, orcaPrice } = prices;
      const spread = Math.abs(rayPrice - orcaPrice);
      const spreadPct = spread / Math.min(rayPrice, orcaPrice) * 100;
      const netPct = spreadPct - FEE_TOTAL;
      const profitable = netPct > 0;

      // Calculate profit for different flash swap sizes
      const sizes = [0.05, 0.1, 0.5, 1, 5, 10, 50];
      const profits = {};
      for (const sol of sizes) {
        const highP = Math.max(rayPrice, orcaPrice);
        const lowP = Math.min(rayPrice, orcaPrice);
        const usdc = sol * highP * 0.9999;
        const solBack = usdc / lowP * 0.9999;
        const gross = (solBack - sol) * (rayPrice + orcaPrice) / 2;
        const net = gross * 0.5 - 0.001; // 50% tip + gas
        profits[sol] = +net.toFixed(4);
      }

      if (profitable) {
        profitableCount++;
        totalNetProfit += profits[10] || 0; // track 10 SOL size
      }

      const entry = {
        ts: new Date().toISOString(),
        cycle,
        rayPrice: +rayPrice.toFixed(4),
        orcaPrice: +orcaPrice.toFixed(4),
        spreadPct: +spreadPct.toFixed(6),
        netPct: +netPct.toFixed(6),
        profitable,
        profits,
        direction: rayPrice < orcaPrice ? "ray→orca" : "orca→ray",
      };
      fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");

      if (profitable) {
        console.log(
          `  ✓ spread=${spreadPct.toFixed(4)}% net=${netPct.toFixed(4)}% ` +
          `@10SOL=$${profits[10]} @50SOL=$${profits[50]} ` +
          `[ray=$${rayPrice.toFixed(2)} orca=$${orcaPrice.toFixed(2)} ${entry.direction}]`
        );
      }

      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      const pctProfitable = cycle > 0 ? (profitableCount / cycle * 100).toFixed(1) : 0;
      process.stdout.write(
        `\r  [${elapsed}m] #${cycle} spread=${spreadPct.toFixed(4)}% profitable=${profitableCount}(${pctProfitable}%) cumProfit=$${totalNetProfit.toFixed(2)}   `
      );

    } catch (e) {
      if (e.message?.includes("429")) await new Promise(r => setTimeout(r, 2000));
    }

    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(console.error);
