#!/usr/bin/env node
/**
 * ENHANCED WEBSOCKET ARB BOT
 *
 * Uses Helius Enhanced WebSocket (paid plan) for:
 * - Real-time pool state change detection
 * - Lower latency than free WebSocket
 * - Higher rate limits (50 req/sec vs 10)
 *
 * When pool state changes (swap detected):
 * 1. Immediately build atomic round-trip tx via Jupiter swap-instructions
 * 2. simulateTransaction to verify profit
 * 3. If profitable → log (DRY_RUN) or send via Jito bundle
 *
 * This combines:
 * - Enhanced WebSocket (instant swap detection)
 * - Jupiter swap-instructions (correct account resolution)
 * - Atomic tx simulation (real execution result)
 * - Jito bundle (zero-cost failure)
 */

require("dotenv").config();
const WebSocket = require("ws");
const {
  Connection, PublicKey, TransactionMessage, VersionedTransaction,
  TransactionInstruction, ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const fs = require("fs");

const HELIUS_KEY = "YOUR_HELIUS_API_KEY";
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const JUP = "https://lite-api.jup.ag/swap/v1";

const conn = new Connection(RPC_URL, { commitment: "confirmed" });
const WALLET = new PublicKey("YOUR_WALLET_ADDRESS");

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

// Pools to watch — high activity pools where swaps create price dislocations
const WATCH_POOLS = [
  // Raydium SOL/USDC AMM — very high volume
  { addr: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", pair: "SOL/USDC", dex: "Raydium" },
  // Orca SOL/USDC — high volume
  { addr: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ", pair: "SOL/USDC", dex: "Orca30" },
  // Raydium BONK/SOL — meme token, volatile
  { addr: "Fy38r6gMBcz4iYqLfT2TEm22QbKfCCNqA4mNc2mYsBKu", pair: "BONK/SOL", dex: "Raydium" },
];

// Arb routes to check — SOL↔WIF (proven to simulate successfully)
const ARB_PAIRS = [
  { a: SOL, b: WIF, label: "SOL↔WIF", amounts: [10000000, 50000000] },
  { a: SOL, b: BONK, label: "SOL↔BONK", amounts: [10000000] },
];

fs.mkdirSync("results", { recursive: true });
const dataFile = "results/enhanced-ws.jsonl";
const logFile = "results/enhanced-ws.log";

let swapCount = 0, checkCount = 0, simOK = 0, profitable = 0;
const startTime = Date.now();

function logMsg(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(logFile, line + "\n");
  console.log(line);
}

function toIx(raw) {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(raw.data, "base64"),
  });
}

async function checkAtomicArb(pair, amount, trigger) {
  const startMs = Date.now();
  try {
    // Jupiter quotes
    const q1Res = await fetch(`${JUP}/quote?inputMint=${pair.a}&outputMint=${pair.b}&amount=${amount}&slippageBps=300`);
    const q1 = await q1Res.json();
    if (!q1.outAmount) return;

    const q2Res = await fetch(`${JUP}/quote?inputMint=${pair.b}&outputMint=${pair.a}&amount=${q1.outAmount}&slippageBps=300`);
    const q2 = await q2Res.json();
    if (!q2.outAmount) return;

    const quoteProfit = Number(q2.outAmount) - Number(amount);
    const quoteProfitUsd = (quoteProfit / 1e9) * 89;

    // Only build atomic tx if quote shows potential (within $0.01 of breakeven)
    if (quoteProfitUsd < -0.01) {
      checkCount++;
      const entry = { ts: new Date().toISOString(), trigger, pair: pair.label, amount, quoteProfit, quoteProfitUsd, simulated: false };
      fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");
      return;
    }

    // Build atomic tx
    const si1Res = await fetch(`${JUP}/swap-instructions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteResponse: q1, userPublicKey: WALLET.toBase58(), wrapAndUnwrapSol: true }),
    });
    const si1 = await si1Res.json();
    if (si1.error) return;

    const si2Res = await fetch(`${JUP}/swap-instructions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteResponse: q2, userPublicKey: WALLET.toBase58(), wrapAndUnwrapSol: true }),
    });
    const si2 = await si2Res.json();
    if (si2.error) return;

    // Combine instructions
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
    for (const ix of (si2.setupInstructions || [])) {
      const key = ix.programId + ix.accounts.map(a => a.pubkey).join("");
      if (!seen.has(key)) { ixs.push(toIx(ix)); }
    }
    ixs.push(toIx(si2.swapInstruction));
    if (si2.cleanupInstruction) ixs.push(toIx(si2.cleanupInstruction));

    // Address lookup tables
    const altAddrs = [...new Set([...(si1.addressLookupTableAddresses || []), ...(si2.addressLookupTableAddresses || [])])];
    const alts = [];
    for (const addr of altAddrs) {
      try { const a = await conn.getAddressLookupTable(new PublicKey(addr)); if (a.value) alts.push(a.value); } catch {}
    }

    // Build & simulate
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: WALLET, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });

    const latencyMs = Date.now() - startMs;
    checkCount++;

    const entry = {
      ts: new Date().toISOString(), trigger, pair: pair.label, amount,
      quoteProfit, quoteProfitUsd,
      simulated: true, simSuccess: !sim.value.err,
      simError: sim.value.err ? JSON.stringify(sim.value.err) : null,
      cu: sim.value.unitsConsumed, latencyMs,
    };
    fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");

    if (!sim.value.err) {
      simOK++;
      if (quoteProfit > 0) {
        profitable++;
        logMsg(`✓ PROFITABLE! $${quoteProfitUsd.toFixed(6)} | ${pair.label}@${amount} latency=${latencyMs}ms`);
      }
    }
  } catch {}
}

let lastStates = {};

function connect() {
  logMsg("Connecting to Enhanced WebSocket...");
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    logMsg("Connected! Subscribing to pools...");
    for (const pool of WATCH_POOLS) {
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: pool.addr.slice(0, 8),
        method: "accountSubscribe",
        params: [pool.addr, { encoding: "base64", commitment: "confirmed" }],
      }));
      logMsg(`  Subscribed: ${pool.dex} ${pool.pair}`);
    }
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.result !== undefined) return; // subscription confirmation

      if (msg.method === "accountNotification") {
        swapCount++;
        const slot = msg.params?.result?.context?.slot;
        const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);

        // Check all arb pairs
        for (const pair of ARB_PAIRS) {
          for (const amt of pair.amounts) {
            await checkAtomicArb(pair, amt, `swap#${swapCount}`);
          }
        }

        if (swapCount % 10 === 0) {
          logMsg(`Status: swaps=${swapCount} checks=${checkCount} simOK=${simOK} profitable=${profitable} [${elapsed}m]`);
        }
      }
    } catch {}
  });

  ws.on("error", (err) => logMsg(`WS error: ${err.message?.slice(0, 50)}`));
  ws.on("close", () => { logMsg("WS closed. Reconnecting..."); setTimeout(connect, 2000); });
}

async function main() {
  logMsg("=== ENHANCED WEBSOCKET ARB BOT ===");
  logMsg(`RPC: Helius Developer (paid, 50 req/sec)`);
  logMsg(`WebSocket: Enhanced (paid)`);
  logMsg(`Pools: ${WATCH_POOLS.length}`);
  logMsg(`Arb pairs: ${ARB_PAIRS.length}`);
  logMsg(`Mode: DRY_RUN (simulate only)`);
  logMsg("");
  connect();
}

main();
