#!/usr/bin/env node
/**
 * ATOMIC SIMULATION: Combine two Jupiter swap-instructions into
 * one transaction and simulateTransaction.
 *
 * This is the first TRUE atomic arb simulation.
 * Previous tests used sequential quotes — this uses combined instructions.
 */

require("dotenv").config();
const {
  Connection, PublicKey, TransactionMessage, VersionedTransaction,
  TransactionInstruction, AddressLookupTableAccount,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const fs = require("fs");

const conn = new Connection(process.env.RPC_URL);
const WALLET = new PublicKey("YOUR_WALLET_ADDRESS");

async function jupQuote(inputMint, outputMint, amount) {
  await new Promise(r => setTimeout(r, 300));
  const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=300`);
  return await r.json();
}

async function jupSwapInstructions(quoteResponse, wrapSol = true) {
  await new Promise(r => setTimeout(r, 300));
  const r = await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: WALLET.toBase58(),
      wrapAndUnwrapSol: wrapSol,
    }),
  });
  return await r.json();
}

function deserializeInstruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(a => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

async function testAtomicArb(inputMint, outputMint, amount, label) {
  try {
    // Get quotes
    const q1 = await jupQuote(inputMint, outputMint, amount);
    if (!q1.outAmount) return null;
    const q2 = await jupQuote(outputMint, inputMint, q1.outAmount);
    if (!q2.outAmount) return null;

    const quoteProfit = Number(q2.outAmount) - Number(amount);

    // Get swap instructions
    const si1 = await jupSwapInstructions(q1, true);
    if (si1.error) return null;
    const si2 = await jupSwapInstructions(q2, true);
    if (si2.error) return null;

    // Combine all instructions into one tx
    const instructions = [];

    // Compute budget
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }));
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));

    // Leg 1: setup + swap
    for (const ix of (si1.setupInstructions || [])) {
      instructions.push(deserializeInstruction(ix));
    }
    instructions.push(deserializeInstruction(si1.swapInstruction));

    // Leg 2: setup + swap
    for (const ix of (si2.setupInstructions || [])) {
      instructions.push(deserializeInstruction(ix));
    }
    instructions.push(deserializeInstruction(si2.swapInstruction));

    // Cleanup (unwrap SOL etc)
    if (si1.cleanupInstruction) instructions.push(deserializeInstruction(si1.cleanupInstruction));
    if (si2.cleanupInstruction) instructions.push(deserializeInstruction(si2.cleanupInstruction));

    // Get address lookup tables
    const altAddrs = [...new Set([
      ...(si1.addressLookupTableAddresses || []),
      ...(si2.addressLookupTableAddresses || []),
    ])];

    const altAccounts = [];
    for (const addr of altAddrs) {
      const alt = await conn.getAddressLookupTable(new PublicKey(addr));
      if (alt.value) altAccounts.push(alt.value);
    }

    // Build versioned transaction
    const blockhash = await conn.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: WALLET,
      recentBlockhash: blockhash.blockhash,
      instructions,
    }).compileToV0Message(altAccounts);

    const tx = new VersionedTransaction(messageV0);

    // Simulate
    const sim = await conn.simulateTransaction(tx, { sigVerify: false });

    const result = {
      label,
      inputAmount: amount,
      quoteProfit,
      simError: sim.value.err ? JSON.stringify(sim.value.err) : null,
      simSuccess: !sim.value.err,
      computeUnits: sim.value.unitsConsumed,
      instructionCount: instructions.length,
      altCount: altAccounts.length,
    };

    return result;
  } catch (e) {
    return { label, error: e.message?.slice(0, 100) };
  }
}

async function main() {
  console.log("=== ATOMIC SIMULATION: Combined swap instructions ===\n");

  const SOL = "So11111111111111111111111111111111111111112";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
  const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

  const tests = [
    { a: SOL, b: BONK, amt: 10000000, label: "SOL↔BONK @$0.89" },
    { a: SOL, b: BONK, amt: 50000000, label: "SOL↔BONK @$4.45" },
    { a: SOL, b: USDC, amt: 10000000, label: "SOL↔USDC @$0.89" },
    { a: SOL, b: WIF, amt: 10000000, label: "SOL↔WIF @$0.89" },
    { a: SOL, b: JUP, amt: 10000000, label: "SOL↔JUP @$0.89" },
    { a: USDC, b: USDT, amt: 1000000, label: "USDC↔USDT @$1" },
    { a: USDC, b: USDT, amt: 10000000, label: "USDC↔USDT @$10" },
    { a: SOL, b: BONK, amt: 1000000, label: "SOL↔BONK @$0.09" },
  ];

  fs.mkdirSync("results", { recursive: true });
  const results = [];

  for (const test of tests) {
    console.log(`Testing: ${test.label}...`);
    const result = await testAtomicArb(test.a, test.b, test.amt, test.label);
    if (result) {
      results.push(result);
      if (result.simSuccess) {
        console.log(`  ✓ SIMULATION SUCCESS! quoteProfit=${result.quoteProfit} lamports, CU=${result.computeUnits}`);
      } else if (result.simError) {
        console.log(`  ✗ Sim failed: ${result.simError}`);
      } else if (result.error) {
        console.log(`  ✗ Error: ${result.error}`);
      }
    } else {
      console.log(`  ✗ Quote failed`);
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log("=== ATOMIC SIMULATION RESULTS ===\n");

  const successes = results.filter(r => r.simSuccess);
  console.log(`Total tests: ${results.length}`);
  console.log(`Simulation success: ${successes.length}`);

  if (successes.length > 0) {
    console.log("\n=== SUCCESSFUL ATOMIC SIMULATIONS ===");
    for (const r of successes) {
      const profitUsd = (r.quoteProfit / 1e9) * 89; // rough
      console.log(`  ${r.label}: quoteProfit=${r.quoteProfit} lamports ($${profitUsd.toFixed(6)}) CU=${r.computeUnits}`);
    }
    console.log("\n→ These can be executed as real atomic transactions via Jito bundle");
  }

  for (const r of results) {
    console.log(`\n${r.label}:`);
    console.log(`  ${JSON.stringify(r, null, 2)}`);
  }

  fs.writeFileSync("results/atomic-sim.json", JSON.stringify(results, null, 2));
  console.log("\nSaved to results/atomic-sim.json");
}

main().catch(console.error);
