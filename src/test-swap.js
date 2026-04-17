#!/usr/bin/env node
/**
 * Test swap simulation for the golden pair:
 *   Raydium CLMM (8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj)
 *   Orca Whirlpool (83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d)
 *
 * DRY RUN only. Simulates the transaction without sending.
 */

require("dotenv").config();
const { Connection, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const BN = require("bn.js");
const fs = require("fs");
const path = require("path");

const {
  RAYDIUM_CLMM_POOL,
  ORCA_WHIRLPOOL_POOL,
  fetchRaydiumClmmState,
  fetchOrcaWhirlpoolState,
  getAssociatedTokenAddress,
  buildArbTransaction,
  WSOL_MINT,
  USDC_MINT,
} = require("./executor");

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const WALLET_PATH = path.resolve(__dirname, "../../.bot-wallet.json");

function loadWallet() {
  const data = JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8"));
  const secretKeyBytes = Buffer.from(data.secretKeyBase64, "base64");
  return Keypair.fromSecretKey(new Uint8Array(secretKeyBytes));
}

async function main() {
  console.log("=== SWAP SIMULATION TEST ===\n");

  const connection = new Connection(RPC_URL, { commitment: "confirmed" });
  const wallet = loadWallet();
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  // 1. Read both pool states
  console.log("--- Reading pool states ---");
  const [rayPool, orcaPool] = await Promise.all([
    fetchRaydiumClmmState(connection, RAYDIUM_CLMM_POOL),
    fetchOrcaWhirlpoolState(connection, ORCA_WHIRLPOOL_POOL),
  ]);

  const Q64 = Math.pow(2, 64);
  const raySqrt = Number(rayPool.sqrtPriceX64.toString()) / Q64;
  const orcaSqrt = Number(orcaPool.sqrtPrice.toString()) / Q64;
  const rayPrice = raySqrt * raySqrt * 1000; // *1000 for SOL decimal adjustment (9-6=3)
  const orcaPrice = orcaSqrt * orcaSqrt * 1000;
  const spread = Math.abs(rayPrice - orcaPrice) / Math.min(rayPrice, orcaPrice) * 100;

  console.log(`Raydium CLMM:`);
  console.log(`  Pool: ${RAYDIUM_CLMM_POOL.toBase58()}`);
  console.log(`  Config: ${rayPool.ammConfig.toBase58()}`);
  console.log(`  MintA: ${rayPool.mintA.toBase58()}`);
  console.log(`  MintB: ${rayPool.mintB.toBase58()}`);
  console.log(`  VaultA(SOL): ${rayPool.vaultA.toBase58()}`);
  console.log(`  VaultB(USDC): ${rayPool.vaultB.toBase58()}`);
  console.log(`  ObservationKey: ${rayPool.observationKey.toBase58()}`);
  console.log(`  Tick: ${rayPool.tickCurrent}, Spacing: ${rayPool.tickSpacing}`);
  console.log(`  Price: $${rayPrice.toFixed(4)}`);
  console.log();

  console.log(`Orca Whirlpool:`);
  console.log(`  Pool: ${ORCA_WHIRLPOOL_POOL.toBase58()}`);
  console.log(`  MintA: ${orcaPool.tokenMintA.toBase58()}`);
  console.log(`  MintB: ${orcaPool.tokenMintB.toBase58()}`);
  console.log(`  VaultA(SOL): ${orcaPool.tokenVaultA.toBase58()}`);
  console.log(`  VaultB(USDC): ${orcaPool.tokenVaultB.toBase58()}`);
  console.log(`  Tick: ${orcaPool.tickCurrentIndex}, Spacing: ${orcaPool.tickSpacing}`);
  console.log(`  Price: $${orcaPrice.toFixed(4)}`);
  console.log();

  console.log(`Spread: ${spread.toFixed(4)}% (fee: 0.02%, net: ${(spread - 0.02).toFixed(4)}%)`);
  const direction = rayPrice < orcaPrice ? "raydium_cheap" : "orca_cheap";
  console.log(`Direction: ${direction} (buy SOL on ${direction === "raydium_cheap" ? "Raydium" : "Orca"}, sell on ${direction === "raydium_cheap" ? "Orca" : "Raydium"})`);
  console.log();

  // 2. Check user token accounts
  console.log("--- User token accounts ---");
  const userWSOL = getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);
  const userUSDC = getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
  console.log(`WSOL ATA: ${userWSOL.toBase58()}`);
  console.log(`USDC ATA: ${userUSDC.toBase58()}`);

  const [wsolInfo, usdcInfo] = await connection.getMultipleAccountsInfo([userWSOL, userUSDC]);
  console.log(`WSOL ATA exists: ${!!wsolInfo}`);
  console.log(`USDC ATA exists: ${!!usdcInfo}`);
  if (wsolInfo) {
    const wsolBalance = new BN(wsolInfo.data.slice(64, 72), "le");
    console.log(`WSOL balance: ${wsolBalance.toNumber() / LAMPORTS_PER_SOL} SOL`);
  }
  if (usdcInfo) {
    const usdcBalance = new BN(usdcInfo.data.slice(64, 72), "le");
    console.log(`USDC balance: ${usdcBalance.toNumber() / 1e6} USDC`);
  }
  console.log();

  // 3. Build and simulate transaction
  const testAmountSOL = 0.01;
  const inputAmount = new BN(Math.floor(testAmountSOL * LAMPORTS_PER_SOL));
  console.log(`--- Building test transaction (${testAmountSOL} SOL) ---`);

  try {
    const { tx, rayPool: rp, orcaPool: op } = await buildArbTransaction(connection, wallet, {
      inputAmount,
      minProfitLamports: new BN(0), // no min for test
      jitoTipLamports: 1000, // minimal tip for test
      direction,
    });

    console.log(`\nTransaction built: ${tx.instructions.length} instructions`);
    for (let i = 0; i < tx.instructions.length; i++) {
      const ix = tx.instructions[i];
      console.log(`  [${i}] program=${ix.programId.toBase58().slice(0, 12)}... accounts=${ix.keys.length} data=${ix.data.length}B`);
    }

    // 4. Simulate
    console.log("\n--- Simulating transaction ---");
    // Need to partially sign for simulation
    tx.sign(wallet);

    const simResult = await connection.simulateTransaction(tx);
    const { err, logs, unitsConsumed } = simResult.value;

    if (err) {
      console.log(`\nSIMULATION FAILED:`);
      console.log(`  Error: ${JSON.stringify(err)}`);
    } else {
      console.log(`\nSIMULATION SUCCESS`);
    }

    console.log(`  Compute units consumed: ${unitsConsumed || "N/A"}`);

    if (logs && logs.length > 0) {
      console.log(`\n  Logs (last 20):`);
      const showLogs = logs.slice(-20);
      for (const log of showLogs) {
        console.log(`    ${log}`);
      }
    }

    // 5. Summary
    console.log("\n=== SUMMARY ===");
    console.log(`Pool pair: Raydium CLMM <-> Orca Whirlpool (SOL/USDC 0.01%)`);
    console.log(`Spread: ${spread.toFixed(4)}%`);
    console.log(`Direction: ${direction}`);
    console.log(`Test amount: ${testAmountSOL} SOL`);
    console.log(`Simulation: ${err ? "FAILED" : "SUCCESS"}`);
    if (err) {
      console.log(`\nTo debug: check if WSOL ATA has sufficient balance.`);
      console.log(`You may need to wrap SOL first:`);
      console.log(`  spl-token wrap ${testAmountSOL}`);
    }

  } catch (e) {
    console.error(`\nTransaction build failed: ${e.message}`);
    console.error(e.stack);
  }
}

main().catch(console.error);
