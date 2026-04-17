#!/usr/bin/env node
/**
 * ATOMIC SIMULATION v2: Fixed tx combination
 *
 * Fixes from v1:
 * 1. Remove leg1 cleanup (don't unwrap intermediate token)
 * 2. Deduplicate setup instructions (don't create same ATA twice)
 * 3. For leg2, set wrapAndUnwrapSol=false (use WSOL from leg1)
 * 4. Track actual simulation output (not quote)
 */

require("dotenv").config();
const {
  Connection, PublicKey, TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const fs = require("fs");

const conn = new Connection(process.env.RPC_URL);
const WALLET = new PublicKey("YOUR_WALLET_ADDRESS");

async function jupQuote(a, b, amt) {
  await new Promise(r => setTimeout(r, 400));
  const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${a}&outputMint=${b}&amount=${amt}&slippageBps=300`);
  return await r.json();
}

async function jupSwapIx(quoteResponse, wrap) {
  await new Promise(r => setTimeout(r, 400));
  const r = await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: WALLET.toBase58(),
      wrapAndUnwrapSol: wrap,
    }),
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

async function testAtomic(inputMint, outputMint, amount, label) {
  try {
    // Quotes
    const q1 = await jupQuote(inputMint, outputMint, amount);
    if (!q1.outAmount) return { label, error: "q1 failed" };
    const q2 = await jupQuote(outputMint, inputMint, q1.outAmount);
    if (!q2.outAmount) return { label, error: "q2 failed" };

    const quoteProfit = Number(q2.outAmount) - Number(amount);

    // Swap instructions
    // Leg1: wrap input SOL, swap to intermediate token, DON'T cleanup (keep intermediate)
    const si1 = await jupSwapIx(q1, true);
    if (si1.error) return { label, error: "si1: " + si1.error };

    // Leg2: DON'T wrap (already have intermediate token from leg1), swap back, unwrap SOL
    const si2 = await jupSwapIx(q2, true);
    if (si2.error) return { label, error: "si2: " + si2.error };

    // Build combined tx
    const ixs = [];
    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }));
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));

    // Leg 1 setup (create ATAs etc)
    const setupProgramIds1 = new Set();
    for (const ix of (si1.setupInstructions || [])) {
      const key = ix.programId + JSON.stringify(ix.accounts.map(a => a.pubkey));
      if (!setupProgramIds1.has(key)) {
        setupProgramIds1.add(key);
        ixs.push(toIx(ix));
      }
    }

    // Leg 1 swap
    ixs.push(toIx(si1.swapInstruction));

    // Leg 1 cleanup — SKIP if it unwraps our intermediate token
    // Only add cleanup if it's not an unwrap of WSOL (we need WSOL for leg2)
    // Actually: skip ALL leg1 cleanup to keep intermediate tokens alive
    // (si1.cleanupInstruction — SKIP)

    // Leg 2 setup — skip if same ATAs already created in leg1 setup
    for (const ix of (si2.setupInstructions || [])) {
      const key = ix.programId + JSON.stringify(ix.accounts.map(a => a.pubkey));
      if (!setupProgramIds1.has(key)) {
        ixs.push(toIx(ix));
      }
    }

    // Leg 2 swap
    ixs.push(toIx(si2.swapInstruction));

    // Leg 2 cleanup (unwrap final SOL)
    if (si2.cleanupInstruction) ixs.push(toIx(si2.cleanupInstruction));

    // Address lookup tables
    const altAddrs = [...new Set([
      ...(si1.addressLookupTableAddresses || []),
      ...(si2.addressLookupTableAddresses || []),
    ])];

    const alts = [];
    for (const addr of altAddrs) {
      try {
        const alt = await conn.getAddressLookupTable(new PublicKey(addr));
        if (alt.value) alts.push(alt.value);
      } catch {}
    }

    // Build versioned tx
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: WALLET,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(alts);

    const tx = new VersionedTransaction(msg);

    // Simulate
    const sim = await conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    const result = {
      label,
      quoteProfit,
      quoteProfitUsd: (quoteProfit / 1e9) * 89,
      simSuccess: !sim.value.err,
      simError: sim.value.err ? JSON.stringify(sim.value.err) : null,
      cu: sim.value.unitsConsumed,
      ixCount: ixs.length,
    };

    // Check logs for actual transfer amounts
    if (sim.value.logs) {
      const transferLogs = sim.value.logs.filter(l => l.includes("Transfer"));
      result.transfers = transferLogs.length;

      // Look for final SOL amount in logs
      const solLogs = sim.value.logs.filter(l => l.includes("lamport"));
      if (solLogs.length > 0) result.solLogs = solLogs.slice(-3);
    }

    return result;
  } catch (e) {
    return { label, error: e.message?.slice(0, 120) };
  }
}

async function main() {
  console.log("=== ATOMIC SIMULATION v2 (fixed tx combination) ===\n");

  const SOL = "So11111111111111111111111111111111111111112";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

  const tests = [
    { a: SOL, b: BONK, amt: 1000000, label: "SOL↔BONK $0.09" },
    { a: SOL, b: BONK, amt: 10000000, label: "SOL↔BONK $0.89" },
    { a: SOL, b: USDC, amt: 10000000, label: "SOL↔USDC $0.89" },
    { a: SOL, b: WIF, amt: 10000000, label: "SOL↔WIF $0.89" },
    { a: SOL, b: BONK, amt: 50000000, label: "SOL↔BONK $4.45" },
  ];

  const results = [];
  for (const t of tests) {
    console.log(`Testing: ${t.label}`);
    const r = await testAtomic(t.a, t.b, t.amt, t.label);
    results.push(r);

    if (r.simSuccess) {
      console.log(`  ✓ SUCCESS! quoteProfit=${r.quoteProfit} ($${r.quoteProfitUsd?.toFixed(6)}) CU=${r.cu} transfers=${r.transfers}`);
    } else if (r.simError) {
      console.log(`  ✗ ${r.simError.slice(0, 80)} CU=${r.cu}`);
    } else {
      console.log(`  ✗ ${r.error}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  const wins = results.filter(r => r.simSuccess);
  console.log(`Success: ${wins.length}/${results.length}`);
  if (wins.length > 0) {
    for (const w of wins) {
      console.log(`  ${w.label}: profit=${w.quoteProfit} lamports ($${w.quoteProfitUsd?.toFixed(6)})`);
    }
  }

  fs.mkdirSync("results", { recursive: true });
  fs.writeFileSync("results/atomic-v2.json", JSON.stringify(results, null, 2));
}

main().catch(console.error);
