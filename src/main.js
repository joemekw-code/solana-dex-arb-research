/**
 * Solana Arbitrage Bot — Main Loop
 *
 * Polls pool state, finds arb opportunities, executes via Jito bundles.
 * Reads pool reserves directly from on-chain accounts (no Jupiter quoter).
 */

require("dotenv").config();
const { Connection, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const BN = require("bn.js");

const {
  fetchRaydiumPoolState,
  fetchWhirlpoolState,
  KNOWN_RAYDIUM_POOLS,
  KNOWN_ORCA_POOLS,
  getOutputAmount,
} = require("./pools");
const { findOptimalArbSize, generateTestAmounts, buildPoolPairs } = require("./arb");
const { executeArb } = require("./executor");

// --- Config ---
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const WALLET_PATH = process.env.BOT_WALLET_PATH || "../.bot-wallet.json";
const JITO_BLOCK_ENGINE = process.env.JITO_BLOCK_ENGINE || "https://mainnet.block-engine.jito.wtf";
const MIN_PROFIT_LAMPORTS = parseInt(process.env.MIN_PROFIT_LAMPORTS || "5000", 10);
const MIN_BALANCE_LAMPORTS = parseInt(process.env.MIN_BALANCE_LAMPORTS || "50000000", 10); // 0.05 SOL
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "400", 10);
const DRY_RUN = process.env.DRY_RUN === "true";

// --- Stats ---
let stats = {
  startTime: Date.now(),
  cycleCount: 0,
  opportunitiesFound: 0,
  tradesExecuted: 0,
  totalProfitLamports: 0,
  errors: 0,
};

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function loadWallet() {
  const walletPath = path.resolve(__dirname, WALLET_PATH);
  log(`Loading wallet from ${walletPath}`);
  const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));

  // Wallet file stores secret key in base64
  const secretKeyBytes = Buffer.from(walletData.secretKeyBase64, "base64");
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyBytes));
  log(`Wallet loaded: ${keypair.publicKey.toBase58()}`);
  return keypair;
}

async function fetchAllPools(connection) {
  const pools = [];
  const errors = [];

  // Fetch Raydium pools
  for (const addr of KNOWN_RAYDIUM_POOLS) {
    try {
      const pool = await fetchRaydiumPoolState(connection, addr);
      if (pool) pools.push(pool);
    } catch (err) {
      errors.push(`Raydium ${addr}: ${err.message}`);
    }
  }

  // Fetch Orca pools
  for (const addr of KNOWN_ORCA_POOLS) {
    try {
      const pool = await fetchWhirlpoolState(connection, addr);
      if (pool) pools.push(pool);
    } catch (err) {
      errors.push(`Orca ${addr}: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    log(`Pool fetch errors: ${errors.join("; ")}`);
  }

  return pools;
}

function printPoolSummary(pools) {
  for (const p of pools) {
    const coinRes = p.coinReserve.toString();
    const pcRes = p.pcReserve.toString();
    log(`  ${p.dex} ${p.address.toBase58().slice(0, 8)}... coin=${coinRes} pc=${pcRes}`);
  }
}

async function mainLoop() {
  log("=== Solana Arb Bot Starting ===");
  log(`RPC: ${RPC_URL}`);
  log(`Jito: ${JITO_BLOCK_ENGINE}`);
  log(`Min profit: ${MIN_PROFIT_LAMPORTS} lamports`);
  log(`Min balance: ${MIN_BALANCE_LAMPORTS / LAMPORTS_PER_SOL} SOL`);
  log(`Dry run: ${DRY_RUN}`);
  log(`Poll interval: ${POLL_INTERVAL_MS}ms`);

  const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const wallet = loadWallet();

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  log(`Wallet balance: ${balance / LAMPORTS_PER_SOL} SOL (${balance} lamports)`);

  if (balance < MIN_BALANCE_LAMPORTS && !DRY_RUN) {
    log(`ERROR: Balance below minimum threshold (${MIN_BALANCE_LAMPORTS / LAMPORTS_PER_SOL} SOL). Exiting.`);
    process.exit(1);
  }
  if (balance < MIN_BALANCE_LAMPORTS && DRY_RUN) {
    log(`WARNING: Balance low but DRY_RUN=true, continuing for data collection...`);
  }

  // Available for trading (keep reserve for fees)
  const tradableBalance = balance - 10000000; // keep 0.01 SOL for fees
  log(`Tradable balance: ${tradableBalance / LAMPORTS_PER_SOL} SOL`);

  log("\n--- Fetching initial pool states ---");
  let pools = await fetchAllPools(connection);
  log(`Loaded ${pools.length} pools`);
  printPoolSummary(pools);

  const pairs = buildPoolPairs(pools);
  log(`Found ${pairs.length} tradeable pool pairs`);

  if (pairs.length === 0) {
    log("No pool pairs found. Add more pool addresses to pools.js.");
    log("Continuing to poll in case pools become available...");
  }

  // Generate test amounts — use simulated amounts in DRY_RUN mode
  let testAmounts;
  if (DRY_RUN) {
    const BN = (await import("bn.js")).default;
    testAmounts = [0.05, 0.1, 0.5, 1, 5, 10, 50].map(sol => new BN(Math.floor(sol * LAMPORTS_PER_SOL)));
    log(`DRY_RUN: Using simulated trade sizes`);
  } else {
    testAmounts = generateTestAmounts(tradableBalance);
  }
  log(`Testing ${testAmounts.length} trade sizes: ${testAmounts.map((a) => `${a.toNumber() / LAMPORTS_PER_SOL} SOL`).join(", ")}`);

  log("\n--- Starting main loop ---");

  while (true) {
    try {
      stats.cycleCount++;

      // Status update periodically
      if (stats.cycleCount % 50 === 0) {
        if (!DRY_RUN) {
          const currentBalance = await connection.getBalance(wallet.publicKey);
          if (currentBalance < MIN_BALANCE_LAMPORTS) {
            log(`SAFETY: Balance dropped below threshold. Shutting down.`);
            break;
          }
        }
        log(`[cycle ${stats.cycleCount}] Opps found: ${stats.opportunitiesFound} | Trades: ${stats.tradesExecuted} | Profit: ${stats.totalProfitLamports / LAMPORTS_PER_SOL} SOL`);
      }

      // Refresh pool states
      pools = await fetchAllPools(connection);
      const freshPairs = buildPoolPairs(pools);

      // Scan each pair for arb
      for (const [p1, p2] of freshPairs) {
        // Log pool prices every cycle for data
        const p1Price = p1.type === "amm"
          ? Number(p1.pcReserve.toString()) / Number(p1.coinReserve.toString()) * Math.pow(10, (p1.coinDecimals || 9) - (p1.pcDecimals || 6))
          : Number(p1.sqrtPrice?.toString() || 0) / Math.pow(2, 64);
        const p2Price = p2.type === "amm"
          ? Number(p2.pcReserve.toString()) / Number(p2.coinReserve.toString()) * Math.pow(10, (p2.coinDecimals || 9) - (p2.pcDecimals || 6))
          : Number(p2.sqrtPrice?.toString() || 0) / Math.pow(2, 64);

        // Adjust CLMM price for decimal difference
        const decAdj1 = p1.type === "clmm" ? Math.pow(10, (p1.coinDecimals || 9) - (p1.pcDecimals || 6)) : 1;
        const decAdj2 = p2.type === "clmm" ? Math.pow(10, (p2.coinDecimals || 9) - (p2.pcDecimals || 6)) : 1;
        const priceData = {
          ts: new Date().toISOString(),
          cycle: stats.cycleCount,
          dexA: p1.dex, typeA: p1.type, priceA: p1.type === "clmm" ? p1Price * p1Price * decAdj1 : p1Price,
          dexB: p2.dex, typeB: p2.type, priceB: p2.type === "clmm" ? p2Price * p2Price * decAdj2 : p2Price,
        };
        priceData.diffPct = Math.abs(priceData.priceA - priceData.priceB) / Math.min(priceData.priceA, priceData.priceB) * 100;
        fs.appendFileSync("results/price-data.jsonl", JSON.stringify(priceData) + "\n");

        const opp = findOptimalArbSize(p1, p2, testAmounts);

        // Log arb results when found
        if (opp) {
          const dataPoint = {
            ts: new Date().toISOString(),
            cycle: stats.cycleCount,
            dexA: p1.dex, dexB: p2.dex,
            typeA: p1.type, typeB: p2.type,
            input: opp.inputAmount.toNumber() / LAMPORTS_PER_SOL,
            gross: opp.grossProfit.toNumber() / LAMPORTS_PER_SOL,
            net: opp.netProfit.toNumber() / LAMPORTS_PER_SOL,
            profitable: opp.netProfit.gtn(MIN_PROFIT_LAMPORTS),
          };
          fs.appendFileSync("results/arb-data.jsonl", JSON.stringify(dataPoint) + "\n");
        }

        if (opp && opp.netProfit.gtn(MIN_PROFIT_LAMPORTS)) {
          stats.opportunitiesFound++;
          log(`\n*** ARB FOUND (PROFITABLE) ***`);
          log(`  Pair: ${p1.dex}(${p1.type}) vs ${p2.dex}(${p2.type})`);
          log(`  Input: ${opp.inputAmount.toNumber() / LAMPORTS_PER_SOL} SOL`);
          log(`  Gross profit: ${opp.grossProfit.toNumber() / LAMPORTS_PER_SOL} SOL`);
          log(`  Net profit: ${opp.netProfit.toNumber() / LAMPORTS_PER_SOL} SOL`);
          log(`  Jito tip: ${opp.jitoTip.toNumber() / LAMPORTS_PER_SOL} SOL`);

          const result = await executeArb(connection, wallet, opp, JITO_BLOCK_ENGINE, DRY_RUN);

          if (result.success) {
            stats.tradesExecuted++;
            stats.totalProfitLamports += opp.netProfit.toNumber();
            log(`Trade executed successfully!`);
          } else {
            log(`Trade failed: ${result.error || "unknown"}`);
          }
        }
      }
    } catch (err) {
      stats.errors++;
      if (err.message?.includes("429") || err.message?.includes("rate")) {
        log(`Rate limited. Backing off 5s...`);
        await sleep(5000);
      } else {
        log(`Error in cycle ${stats.cycleCount}: ${err.message}`);
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Print final stats
  log("\n=== Bot Stopped ===");
  log(`Runtime: ${((Date.now() - stats.startTime) / 1000 / 60).toFixed(1)} minutes`);
  log(`Cycles: ${stats.cycleCount}`);
  log(`Opportunities found: ${stats.opportunitiesFound}`);
  log(`Trades executed: ${stats.tradesExecuted}`);
  log(`Total profit: ${stats.totalProfitLamports / LAMPORTS_PER_SOL} SOL`);
  log(`Errors: ${stats.errors}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Graceful shutdown
process.on("SIGINT", () => {
  log("\nReceived SIGINT. Shutting down gracefully...");
  log(`Final stats: ${stats.tradesExecuted} trades, ${stats.totalProfitLamports / LAMPORTS_PER_SOL} SOL profit`);
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("\nReceived SIGTERM. Shutting down gracefully...");
  process.exit(0);
});

mainLoop().catch((err) => {
  log(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
