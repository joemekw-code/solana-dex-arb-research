#!/usr/bin/env node
/**
 * BATCH ARB: Multiple arb round-trips in 1 tx = 1 base fee for N profits
 *
 * If 1 arb = 3,930 lamports profit, and base fee = 5,000:
 *   1 arb/tx: 3,930 - 5,000 = -1,070 (赤字)
 *   2 arb/tx: 7,860 - 5,000 = +2,860 (黒字!)
 *   3 arb/tx: 11,790 - 5,000 = +6,790 (黒字!!)
 *
 * Also: test MORE token pairs and sizes simultaneously.
 * Record everything.
 */

require("dotenv").config();
const {
  Connection, PublicKey, TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const fs = require("fs");

const conn = new Connection(process.env.RPC_URL);
const WALLET = new PublicKey("YOUR_WALLET_ADDRESS");
const JUP = "https://lite-api.jup.ag/swap/v1";
const SOL = "So11111111111111111111111111111111111111112";

const TOKENS = [
  { sym: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { sym: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { sym: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { sym: "PYTH", mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" },
  { sym: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
  { sym: "ORCA", mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE" },
  { sym: "DRIFT", mint: "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7" },
  { sym: "KMNO", mint: "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS" },
];

const SIZES = [5000000, 10000000, 20000000, 50000000]; // 0.005-0.05 SOL
const BASE_FEE = 5000;

fs.mkdirSync("results", { recursive: true });
const dataFile = "results/batch-arb.jsonl";
const startTime = Date.now();
const DURATION = 15 * 60 * 1000;
let checks = 0, batchWins = 0;

async function jupQuote(a, b, amt) {
  await new Promise(r => setTimeout(r, 200));
  try {
    const r = await fetch(`${JUP}/quote?inputMint=${a}&outputMint=${b}&amount=${amt}&slippageBps=300`);
    const d = await r.json();
    return d.outAmount ? d : null;
  } catch { return null; }
}

async function jupSwapIx(q) {
  await new Promise(r => setTimeout(r, 200));
  try {
    const r = await fetch(`${JUP}/swap-instructions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: WALLET.toBase58(), wrapAndUnwrapSol: true }),
    });
    return await r.json();
  } catch { return null; }
}

function toIx(raw) {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(raw.data, "base64"),
  });
}

async function testSingleArb(token, size) {
  const q1 = await jupQuote(SOL, token.mint, size);
  if (!q1) return null;
  const q2 = await jupQuote(token.mint, SOL, q1.outAmount);
  if (!q2) return null;
  const profit = Number(q2.outAmount) - size;
  return { token: token.sym, size, profit, q1, q2 };
}

async function testBatchSimulate(arbs) {
  // Combine multiple arbs into 1 tx
  try {
    const allIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100 }),
    ];
    const allAltAddrs = new Set();
    const seenSetup = new Set();

    for (const arb of arbs) {
      const si1 = await jupSwapIx(arb.q1);
      if (!si1 || si1.error) return null;
      const si2 = await jupSwapIx(arb.q2);
      if (!si2 || si2.error) return null;

      for (const ix of (si1.setupInstructions || [])) {
        const key = ix.programId + ix.accounts.map(a => a.pubkey).join("");
        if (!seenSetup.has(key)) { seenSetup.add(key); allIxs.push(toIx(ix)); }
      }
      allIxs.push(toIx(si1.swapInstruction));

      for (const ix of (si2.setupInstructions || [])) {
        const key = ix.programId + ix.accounts.map(a => a.pubkey).join("");
        if (!seenSetup.has(key)) { allIxs.push(toIx(ix)); }
      }
      allIxs.push(toIx(si2.swapInstruction));
      if (si2.cleanupInstruction) allIxs.push(toIx(si2.cleanupInstruction));

      for (const a of (si1.addressLookupTableAddresses || [])) allAltAddrs.add(a);
      for (const a of (si2.addressLookupTableAddresses || [])) allAltAddrs.add(a);
    }

    const alts = [];
    for (const addr of allAltAddrs) {
      try { const a = await conn.getAddressLookupTable(new PublicKey(addr)); if (a.value) alts.push(a.value); } catch {}
    }

    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: WALLET, recentBlockhash: blockhash, instructions: allIxs }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });

    return { success: !sim.value.err, error: sim.value.err, cu: sim.value.unitsConsumed, ixCount: allIxs.length };
  } catch (e) {
    return { success: false, error: e.message?.slice(0, 80) };
  }
}

async function main() {
  console.log("=== BATCH ARB TEST ===");
  console.log("Test 1: Single arb profits across all tokens/sizes");
  console.log("Test 2: Batch 2-3 arbs into 1 tx\n");

  // Test 1: Scan all single arb profits
  console.log("--- Single arb scan ---\n");
  const profitableArbs = [];

  for (const token of TOKENS) {
    for (const size of SIZES) {
      if (Date.now() - startTime > DURATION) break;
      checks++;
      const result = await testSingleArb(token, size);
      if (!result) continue;

      const netSingle = result.profit - BASE_FEE;
      const entry = {
        ts: new Date().toISOString(), test: "single",
        token: result.token, size, profit: result.profit,
        netSingle, profitableSingle: netSingle > 0,
        profitableInBatch2: result.profit * 2 > BASE_FEE,
        profitableInBatch3: result.profit * 3 > BASE_FEE,
      };
      fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");

      if (result.profit > 0) {
        profitableArbs.push(result);
        const b2 = result.profit * 2 > BASE_FEE ? "✓" : "✗";
        const b3 = result.profit * 3 > BASE_FEE ? "✓" : "✗";
        console.log(`  ${result.token}@${(size/1e9).toFixed(3)}SOL: profit=${result.profit} single=${netSingle > 0?"✓":"✗"} batch2=${b2} batch3=${b3}`);
      }
    }
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    process.stdout.write(`\r  [${elapsed}m] ${token.sym} checks=${checks}   `);
  }

  // Test 2: Try batching top profitable arbs
  console.log("\n\n--- Batch simulation ---\n");

  // Sort by profit descending
  profitableArbs.sort((a, b) => b.profit - a.profit);

  if (profitableArbs.length >= 2) {
    // Try batch of 2
    console.log("Batch of 2 (top 2 profitable):");
    const batch2 = profitableArbs.slice(0, 2);
    const totalProfit2 = batch2.reduce((a, b) => a + b.profit, 0);
    console.log(`  Combined profit: ${totalProfit2} lamports, base fee: ${BASE_FEE}, net: ${totalProfit2 - BASE_FEE}`);

    if (totalProfit2 > BASE_FEE) {
      console.log("  → PROFITABLE IN BATCH! Simulating...");
      const simResult = await testBatchSimulate(batch2);
      if (simResult) {
        console.log(`  Simulation: ${simResult.success ? "SUCCESS" : "FAILED"} CU=${simResult.cu} ixs=${simResult.ixCount}`);
        if (simResult.error) console.log(`  Error: ${JSON.stringify(simResult.error)}`);
        if (simResult.success) {
          batchWins++;
          console.log(`  ✓✓ BATCH ARB WORKS! Net profit: ${totalProfit2 - BASE_FEE} lamports ($${((totalProfit2 - BASE_FEE)/1e9*89).toFixed(6)})`);
        }
        fs.appendFileSync(dataFile, JSON.stringify({ test: "batch2", tokens: batch2.map(a=>a.token), totalProfit: totalProfit2, net: totalProfit2 - BASE_FEE, simSuccess: simResult.success, simError: simResult.error, cu: simResult.cu }) + "\n");
      }
    }
  }

  if (profitableArbs.length >= 3) {
    // Try batch of 3
    console.log("\nBatch of 3 (top 3 profitable):");
    const batch3 = profitableArbs.slice(0, 3);
    const totalProfit3 = batch3.reduce((a, b) => a + b.profit, 0);
    console.log(`  Combined profit: ${totalProfit3} lamports, base fee: ${BASE_FEE}, net: ${totalProfit3 - BASE_FEE}`);

    if (totalProfit3 > BASE_FEE) {
      console.log("  → PROFITABLE IN BATCH! Simulating...");
      const simResult = await testBatchSimulate(batch3);
      if (simResult) {
        console.log(`  Simulation: ${simResult.success ? "SUCCESS" : "FAILED"} CU=${simResult.cu} ixs=${simResult.ixCount}`);
        if (simResult.error) console.log(`  Error: ${JSON.stringify(simResult.error)}`);
        if (simResult.success) {
          batchWins++;
          console.log(`  ✓✓ BATCH ARB WORKS! Net profit: ${totalProfit3 - BASE_FEE} lamports ($${((totalProfit3 - BASE_FEE)/1e9*89).toFixed(6)})`);
        }
        fs.appendFileSync(dataFile, JSON.stringify({ test: "batch3", tokens: batch3.map(a=>a.token), totalProfit: totalProfit3, net: totalProfit3 - BASE_FEE, simSuccess: simResult.success, simError: simResult.error, cu: simResult.cu }) + "\n");
      }
    }
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log("\n" + "=".repeat(50));
  console.log(`BATCH ARB RESULTS: ${elapsed}m | ${checks} single checks | ${batchWins} batch wins`);
  console.log(`Profitable singles: ${profitableArbs.length}`);
  if (profitableArbs.length > 0) {
    console.log(`Top profits: ${profitableArbs.slice(0,5).map(a=>`${a.token}@${(a.size/1e9).toFixed(3)}=${a.profit}`).join(", ")}`);
  }
}

main().catch(console.error);
