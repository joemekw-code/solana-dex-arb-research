#!/usr/bin/env node
/**
 * ATOMIC MONITOR: Continuously simulate atomic arb for SOL↔WIF
 * (the only pair where atomic simulation succeeded)
 *
 * Run for 15 min, record all results.
 * If profit ever goes positive → we have a real arb.
 */

require("dotenv").config();
const {
  Connection, PublicKey, TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const fs = require("fs");

const conn = new Connection(process.env.RPC_URL);
const WALLET = new PublicKey("YOUR_WALLET_ADDRESS");
const SOL = "So11111111111111111111111111111111111111112";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

async function jupQuote(a, b, amt) {
  const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${a}&outputMint=${b}&amount=${amt}&slippageBps=300`);
  return await r.json();
}

async function jupSwapIx(q, wrap) {
  const r = await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: WALLET.toBase58(), wrapAndUnwrapSol: wrap }),
  });
  return await r.json();
}

function toIx(raw) {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(raw.data, "base64"),
  });
}

async function runOnce(amount) {
  const q1 = await jupQuote(SOL, WIF, amount);
  if (!q1.outAmount) return null;
  await new Promise(r => setTimeout(r, 300));
  const q2 = await jupQuote(WIF, SOL, q1.outAmount);
  if (!q2.outAmount) return null;

  const quoteProfit = Number(q2.outAmount) - Number(amount);

  await new Promise(r => setTimeout(r, 300));
  const si1 = await jupSwapIx(q1, true);
  if (si1.error) return null;
  await new Promise(r => setTimeout(r, 300));
  const si2 = await jupSwapIx(q2, true);
  if (si2.error) return null;

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
  ];

  const seen = new Set();
  for (const ix of (si1.setupInstructions || [])) {
    const key = ix.programId + ix.accounts.map(a => a.pubkey).join("");
    if (!seen.has(key)) { seen.add(key); ixs.push(toIx(ix)); }
  }
  ixs.push(toIx(si1.swapInstruction));
  // Skip si1 cleanup
  for (const ix of (si2.setupInstructions || [])) {
    const key = ix.programId + ix.accounts.map(a => a.pubkey).join("");
    if (!seen.has(key)) { ixs.push(toIx(ix)); }
  }
  ixs.push(toIx(si2.swapInstruction));
  if (si2.cleanupInstruction) ixs.push(toIx(si2.cleanupInstruction));

  const altAddrs = [...new Set([...(si1.addressLookupTableAddresses || []), ...(si2.addressLookupTableAddresses || [])])];
  const alts = [];
  for (const addr of altAddrs) {
    try { const a = await conn.getAddressLookupTable(new PublicKey(addr)); if (a.value) alts.push(a.value); } catch {}
  }

  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: WALLET, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });

  return {
    ts: new Date().toISOString(),
    quoteProfit,
    quoteProfitUsd: (quoteProfit / 1e9) * 89,
    simSuccess: !sim.value.err,
    simError: sim.value.err ? JSON.stringify(sim.value.err) : null,
    cu: sim.value.unitsConsumed,
  };
}

async function main() {
  console.log("=== ATOMIC MONITOR: SOL↔WIF continuous simulation ===\n");

  fs.mkdirSync("results", { recursive: true });
  const dataFile = "results/atomic-monitor.jsonl";
  const startTime = Date.now();
  const DURATION = 15 * 60 * 1000;
  let cycle = 0, wins = 0, simSuccesses = 0;

  while (Date.now() - startTime < DURATION) {
    cycle++;
    for (const amt of [10000000, 50000000]) {
      const r = await runOnce(amt);
      if (!r) continue;

      fs.appendFileSync(dataFile, JSON.stringify(r) + "\n");

      if (r.simSuccess) {
        simSuccesses++;
        if (r.quoteProfit > 0) {
          wins++;
          console.log(`\n  ✓ PROFIT! $${r.quoteProfitUsd.toFixed(6)} (${r.quoteProfit} lamports) CU=${r.cu}`);
        }
      }

      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      process.stdout.write(`\r  [${elapsed}m] #${cycle} simOK=${simSuccesses} profit=${wins} last=$${r.quoteProfitUsd?.toFixed(6)||"?"}   `);
    }
  }

  console.log("\n\n=== RESULTS ===");
  const lines = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(JSON.parse);
  const successful = lines.filter(l => l.simSuccess);
  const profitable = successful.filter(l => l.quoteProfit > 0);
  console.log(`Cycles: ${cycle}`);
  console.log(`Sim success: ${successful.length}/${lines.length}`);
  console.log(`Quote profitable: ${profitable.length}`);

  if (profitable.length > 0) {
    console.log("\nProfitable moments:");
    for (const p of profitable) console.log(`  ${p.ts} $${p.quoteProfitUsd.toFixed(6)}`);
  }

  const profits = successful.map(l => l.quoteProfitUsd);
  if (profits.length > 0) {
    console.log(`\nProfit range: $${Math.min(...profits).toFixed(6)} to $${Math.max(...profits).toFixed(6)}`);
    console.log(`Average: $${(profits.reduce((a, b) => a + b, 0) / profits.length).toFixed(6)}`);
  }
}

main().catch(console.error);
