/**
 * Transaction builder and Jito bundle submission.
 *
 * Builds an atomic Solana transaction with two swap instructions:
 *   - Raydium CLMM (CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK)
 *   - Orca Whirlpool (whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc)
 *
 * Submits via Jito bundle for priority execution.
 */

const {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const BN = require("bn.js");

// --- Constants ---
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RAYDIUM_CLMM_PROGRAM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// Pool addresses
const RAYDIUM_CLMM_POOL = new PublicKey("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj");
const ORCA_WHIRLPOOL_POOL = new PublicKey("83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d");

// Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiNPLArUT",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSLab7nb4mQ8UaYpGKt",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

// --- Helpers ---
function readU64(data, offset) { return new BN(data.slice(offset, offset + 8), "le"); }
function readU128(data, offset) { return new BN(data.slice(offset, offset + 16), "le"); }
function readI32(data, offset) { return data.readInt32LE(offset); }
function readU16(data, offset) { return data.readUInt16LE(offset); }
function readPubkey(data, offset) { return new PublicKey(data.slice(offset, offset + 32)); }

/**
 * Derive Associated Token Account address (no SDK needed).
 */
function getAssociatedTokenAddress(mint, owner) {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

/**
 * Build instruction to create ATA if it doesn't exist.
 */
function buildCreateATAInstruction(payer, owner, mint) {
  const ata = getAssociatedTokenAddress(mint, owner);
  return {
    ata,
    instruction: new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(0),
    }),
  };
}

// =============================================================================
// Raydium CLMM pool state parsing
// =============================================================================

/**
 * Raydium CLMM pool account layout (partial).
 * Program: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
 *
 * Offsets determined from Raydium CLMM IDL:
 *   8: bump (1 byte array)
 *   9: ammConfig (32)
 *   41: creator (32) -- pool creator
 *   73: mintA (32)
 *   105: mintB (32)
 *   137: vaultA (32)
 *   169: vaultB (32)
 *   201: observationKey (32)
 *   233: mintDecimalsA (1)
 *   234: mintDecimalsB (1)
 *   235: tickSpacing (2)
 *   237: liquidity (16) u128
 *   253: sqrtPriceX64 (16) u128
 *   269: tickCurrent (4) i32
 *   ... more fields follow
 */
const RAYDIUM_CLMM_LAYOUT = {
  ammConfig: 9,
  creator: 41,
  mintA: 73,
  mintB: 105,
  vaultA: 137,
  vaultB: 169,
  observationKey: 201,
  mintDecimalsA: 233,
  mintDecimalsB: 234,
  tickSpacing: 235,
  liquidity: 237,
  sqrtPriceX64: 253,
  tickCurrent: 269,
};

function parseRaydiumClmmPool(data) {
  const L = RAYDIUM_CLMM_LAYOUT;
  return {
    ammConfig: readPubkey(data, L.ammConfig),
    creator: readPubkey(data, L.creator),
    mintA: readPubkey(data, L.mintA),
    mintB: readPubkey(data, L.mintB),
    vaultA: readPubkey(data, L.vaultA),
    vaultB: readPubkey(data, L.vaultB),
    observationKey: readPubkey(data, L.observationKey),
    mintDecimalsA: data[L.mintDecimalsA],
    mintDecimalsB: data[L.mintDecimalsB],
    tickSpacing: readU16(data, L.tickSpacing),
    liquidity: readU128(data, L.liquidity),
    sqrtPriceX64: readU128(data, L.sqrtPriceX64),
    tickCurrent: readI32(data, L.tickCurrent),
  };
}

async function fetchRaydiumClmmState(connection, poolAddress) {
  const poolPubkey = typeof poolAddress === "string" ? new PublicKey(poolAddress) : poolAddress;
  const info = await connection.getAccountInfo(poolPubkey);
  if (!info) throw new Error(`Raydium CLMM pool not found: ${poolPubkey.toBase58()}`);
  return parseRaydiumClmmPool(info.data);
}

// =============================================================================
// Orca Whirlpool pool state parsing
// =============================================================================

/**
 * Orca Whirlpool layout (same as pools.js but repeated here for self-containment).
 */
const ORCA_WP_LAYOUT = {
  whirlpoolsConfig: 8,
  tickSpacing: 41,
  feeRate: 45,
  liquidity: 49,
  sqrtPrice: 65,
  tickCurrentIndex: 81,
  tokenMintA: 101,
  tokenVaultA: 133,
  tokenMintB: 181,
  tokenVaultB: 213,
};

function parseOrcaWhirlpool(data) {
  const L = ORCA_WP_LAYOUT;
  return {
    whirlpoolsConfig: readPubkey(data, L.whirlpoolsConfig),
    tickSpacing: readU16(data, L.tickSpacing),
    feeRate: readU16(data, L.feeRate),
    liquidity: readU128(data, L.liquidity),
    sqrtPrice: readU128(data, L.sqrtPrice),
    tickCurrentIndex: readI32(data, L.tickCurrentIndex),
    tokenMintA: readPubkey(data, L.tokenMintA),
    tokenVaultA: readPubkey(data, L.tokenVaultA),
    tokenMintB: readPubkey(data, L.tokenMintB),
    tokenVaultB: readPubkey(data, L.tokenVaultB),
  };
}

async function fetchOrcaWhirlpoolState(connection, poolAddress) {
  const poolPubkey = typeof poolAddress === "string" ? new PublicKey(poolAddress) : poolAddress;
  const info = await connection.getAccountInfo(poolPubkey);
  if (!info) throw new Error(`Orca Whirlpool not found: ${poolPubkey.toBase58()}`);
  return parseOrcaWhirlpool(info.data);
}

// =============================================================================
// Tick array derivation
// =============================================================================

/**
 * Raydium CLMM tick array PDA.
 * Seeds: ["tick_array", pool, startTickIndex (i32 LE)]
 */
/**
 * Raydium CLMM tick arrays for SOL/USDC 0.01% pool.
 * Hard-coded from real on-chain transaction analysis.
 * These are the actual initialized tick array accounts.
 */
const KNOWN_RAY_TICK_ARRAYS = [
  { start: -24480, addr: new PublicKey("77oUVVyZvxwNbsQS5E5pNNM4wiehwgYTTSTiLYLav1pC") },
  { start: -24420, addr: new PublicKey("EEKrPVi1weD8U7GxXoDxd8D2q1rb9aRFR6z6M9QxkymU") },
  { start: -24240, addr: new PublicKey("BVEH5d44tdVCBpveKm2TR2Pu368SHKHq9vPLmkHo7YM5") },
  { start: -24120, addr: new PublicKey("BATxzQ9Gn1tjVHBysnPHHK7qW2LJumUeZCSXfk3idscF") },
  { start: -24060, addr: new PublicKey("2pnhV8MxFaVqXifACiWpr2Vck1Cyty1c3BQMmoktPW6p") },
  { start: 0, addr: new PublicKey("FXLkk8Tsbm85S89AjUKEvJmj1kw7Q4sf1JBjxjfbQeG") },
  { start: 22800, addr: new PublicKey("4mEDn3bSsjXtuUm4xR4K5DHCmXJLU3QCu71158bkHJ4V") },
  { start: 443580, addr: new PublicKey("Gj5fJF4ooyxNtY8jwLLvfinGQAU39CpSb5WE81bieXi4") },
];

const TICK_ARRAY_SIZE = 120;

function getTickArrayStartIndex(tickIndex, tickSpacing) {
  const ticksInArray = tickSpacing * TICK_ARRAY_SIZE;
  let startIndex = Math.floor(tickIndex / ticksInArray) * ticksInArray;
  if (tickIndex < 0 && tickIndex % ticksInArray !== 0) {
    startIndex -= ticksInArray;
  }
  return startIndex;
}

function getRaydiumTickArrays(poolPubkey, tickCurrent, tickSpacing, aToB) {
  if (aToB) {
    // a→b (price decreasing): need tick arrays at or below current tick
    const below = KNOWN_RAY_TICK_ARRAYS
      .filter(t => t.start <= tickCurrent)
      .sort((a, b) => b.start - a.start); // descending (closest first)
    return below.slice(0, 3).map(t => t.addr);
  } else {
    // b→a (price increasing): need tick arrays at or above current tick - start with current
    const above = KNOWN_RAY_TICK_ARRAYS
      .filter(t => t.start + 120 >= tickCurrent) // tick array that contains or is above current
      .sort((a, b) => a.start - b.start); // ascending (closest first)
    return above.slice(0, 3).map(t => t.addr);
  }
}

/**
 * Orca Whirlpool tick array PDA.
 * Seeds: ["tick_array", whirlpool, startTickIndex (i32 LE as string)]
 *
 * NOTE: Orca uses the string representation of the start tick index, not raw bytes.
 */
function getOrcaTickArrayAddress(whirlpool, startTickIndex) {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(startTickIndex.toString())],
    ORCA_WHIRLPOOL_PROGRAM
  );
  return address;
}

function getOrcaTickArrays(poolPubkey, tickCurrent, tickSpacing, aToB) {
  const ORCA_TICKS_PER_ARRAY = 88;
  const ticksInArray = tickSpacing * ORCA_TICKS_PER_ARRAY;
  const startIdx = Math.floor(tickCurrent / ticksInArray) * ticksInArray;
  const arrays = [];
  for (let i = 0; i < 3; i++) {
    const offset = aToB ? -(i * ticksInArray) : (i * ticksInArray);
    arrays.push(getOrcaTickArrayAddress(poolPubkey, startIdx + offset));
  }
  return arrays;
}

/**
 * Orca oracle PDA.
 * Seeds: ["oracle", whirlpool]
 */
function getOrcaOracleAddress(whirlpool) {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), whirlpool.toBuffer()],
    ORCA_WHIRLPOOL_PROGRAM
  );
  return address;
}

// =============================================================================
// Swap instruction builders
// =============================================================================

/**
 * Encode a u64 as 8 bytes LE.
 */
function encodeU64(value) {
  const bn = new BN(value.toString());
  return bn.toArrayLike(Buffer, "le", 8);
}

/**
 * Encode a u128 as 16 bytes LE.
 */
function encodeU128(value) {
  const bn = new BN(value.toString());
  return bn.toArrayLike(Buffer, "le", 16);
}

/**
 * Build Raydium CLMM swap instruction.
 *
 * Discriminator: [248, 198, 158, 145, 225, 117, 135, 200]
 * Data: discriminator(8) + amount(u64) + otherAmountThreshold(u64) + sqrtPriceLimitX64(u128) + isBaseInput(bool)
 *
 * Accounts (in order):
 *  0: payer (signer, writable)
 *  1: ammConfig
 *  2: poolState (writable)
 *  3: inputTokenAccount (writable)
 *  4: outputTokenAccount (writable)
 *  5: inputVault (writable)
 *  6: outputVault (writable)
 *  7: observationState (writable)
 *  8: tokenProgram
 *  9: tickArrayLower (writable)
 * 10: tickArrayCurrent (writable)
 * 11: tickArrayUpper (writable)
 */
function buildRaydiumClmmSwapInstruction({
  payer,
  ammConfig,
  poolState,
  inputTokenAccount,
  outputTokenAccount,
  inputVault,
  outputVault,
  observationState,
  tickArrays, // [lower, current, upper]
  amount,
  otherAmountThreshold,
  sqrtPriceLimitX64,
  isBaseInput,
}) {
  const discriminator = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
  const data = Buffer.concat([
    discriminator,
    encodeU64(amount),
    encodeU64(otherAmountThreshold),
    encodeU128(sqrtPriceLimitX64),
    Buffer.from([isBaseInput ? 1 : 0]),
  ]);

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: ammConfig, isSigner: false, isWritable: false },
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: inputVault, isSigner: false, isWritable: true },
    { pubkey: outputVault, isSigner: false, isWritable: true },
    { pubkey: observationState, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: tickArrays[0], isSigner: false, isWritable: true },
    { pubkey: tickArrays[1], isSigner: false, isWritable: true },
    { pubkey: tickArrays[2], isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: RAYDIUM_CLMM_PROGRAM,
    keys,
    data,
  });
}

/**
 * Build Orca Whirlpool swap instruction.
 *
 * Discriminator: [248, 198, 158, 145, 225, 117, 135, 200]
 * Data: discriminator(8) + amount(u64) + otherAmountThreshold(u64) + sqrtPriceLimit(u128) + amountSpecifiedIsInput(bool) + aToB(bool)
 *
 * Accounts (in order):
 *  0: tokenProgram
 *  1: tokenAuthority (signer)
 *  2: whirlpool (writable)
 *  3: tokenOwnerAccountA (writable)
 *  4: tokenVaultA (writable)
 *  5: tokenOwnerAccountB (writable)
 *  6: tokenVaultB (writable)
 *  7: tickArray0 (writable)
 *  8: tickArray1 (writable)
 *  9: tickArray2 (writable)
 * 10: oracle (writable)
 */
function buildOrcaWhirlpoolSwapInstruction({
  tokenAuthority,
  whirlpool,
  tokenOwnerAccountA,
  tokenVaultA,
  tokenOwnerAccountB,
  tokenVaultB,
  tickArrays, // [0, 1, 2]
  oracle,
  amount,
  otherAmountThreshold,
  sqrtPriceLimit,
  amountSpecifiedIsInput,
  aToB,
}) {
  const discriminator = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
  const data = Buffer.concat([
    discriminator,
    encodeU64(amount),
    encodeU64(otherAmountThreshold),
    encodeU128(sqrtPriceLimit),
    Buffer.from([amountSpecifiedIsInput ? 1 : 0]),
    Buffer.from([aToB ? 1 : 0]),
  ]);

  const keys = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: tokenAuthority, isSigner: true, isWritable: false },
    { pubkey: whirlpool, isSigner: false, isWritable: true },
    { pubkey: tokenOwnerAccountA, isSigner: false, isWritable: true },
    { pubkey: tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: tokenOwnerAccountB, isSigner: false, isWritable: true },
    { pubkey: tokenVaultB, isSigner: false, isWritable: true },
    { pubkey: tickArrays[0], isSigner: false, isWritable: true },
    { pubkey: tickArrays[1], isSigner: false, isWritable: true },
    { pubkey: tickArrays[2], isSigner: false, isWritable: true },
    { pubkey: oracle, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: ORCA_WHIRLPOOL_PROGRAM,
    keys,
    data,
  });
}

// =============================================================================
// Jito tip
// =============================================================================

function buildJitoTipInstruction(fromPubkey, tipLamports) {
  const tipAccount = new PublicKey(
    JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
  );
  return SystemProgram.transfer({
    fromPubkey,
    toPubkey: tipAccount,
    lamports: tipLamports,
  });
}

// =============================================================================
// Main transaction builder
// =============================================================================

/**
 * Determine swap direction for each pool.
 *
 * Both pools are SOL/USDC. TokenA = SOL (WSOL), TokenB = USDC.
 *
 * If Raydium price < Orca price:
 *   - Buy SOL on Raydium (sell USDC -> get SOL) = b→a on Raydium
 *   - Sell SOL on Orca (sell SOL -> get USDC)   = a→b on Orca
 *
 * If Orca price < Raydium price:
 *   - Buy SOL on Orca (sell USDC -> get SOL) = b→a on Orca
 *   - Sell SOL on Raydium (sell SOL -> get USDC) = a→b on Raydium
 *
 * For a SOL-starting arb (we hold SOL):
 *   - Sell SOL on expensive pool -> get USDC
 *   - Buy SOL on cheap pool with USDC -> get SOL back
 */

/**
 * sqrtPriceLimit values for boundary conditions.
 * MIN_SQRT_PRICE and MAX_SQRT_PRICE from the protocols.
 */
const MIN_SQRT_PRICE_X64 = new BN("4295048017"); // MIN + 1 (exclusive boundary)
const MAX_SQRT_PRICE_X64 = new BN("79226673515401279992447579054"); // MAX - 1 (exclusive boundary)

/**
 * Build the complete atomic arbitrage transaction.
 *
 * @param {Connection} connection
 * @param {Keypair} wallet
 * @param {object} params
 * @param {BN} params.inputAmount - Amount of SOL (lamports) to trade
 * @param {BN} params.minProfitLamports - Minimum profit (abort if less)
 * @param {number} params.jitoTipLamports - Jito tip amount
 * @param {string} params.direction - "raydium_cheap" or "orca_cheap"
 */
async function buildArbTransaction(connection, wallet, params) {
  const {
    inputAmount,
    minProfitLamports = new BN(1),
    jitoTipLamports = 10000,
    direction, // "raydium_cheap" = buy on raydium, sell on orca
  } = params;

  // 1. Fetch both pool states
  const [rayPool, orcaPool] = await Promise.all([
    fetchRaydiumClmmState(connection, RAYDIUM_CLMM_POOL),
    fetchOrcaWhirlpoolState(connection, ORCA_WHIRLPOOL_POOL),
  ]);

  console.log(`[executor] Raydium CLMM: tick=${rayPool.tickCurrent}, tickSpacing=${rayPool.tickSpacing}`);
  console.log(`[executor] Orca Whirlpool: tick=${orcaPool.tickCurrentIndex}, tickSpacing=${orcaPool.tickSpacing}`);
  console.log(`[executor] Raydium vaultA(SOL)=${rayPool.vaultA.toBase58()}`);
  console.log(`[executor] Raydium vaultB(USDC)=${rayPool.vaultB.toBase58()}`);
  console.log(`[executor] Orca vaultA(SOL)=${orcaPool.tokenVaultA.toBase58()}`);
  console.log(`[executor] Orca vaultB(USDC)=${orcaPool.tokenVaultB.toBase58()}`);

  // 2. Derive user token accounts
  const userWSOL = getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);
  const userUSDC = getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);

  console.log(`[executor] User WSOL ATA: ${userWSOL.toBase58()}`);
  console.log(`[executor] User USDC ATA: ${userUSDC.toBase58()}`);

  // 3. Check if ATAs exist
  const [wsolInfo, usdcInfo] = await connection.getMultipleAccountsInfo([userWSOL, userUSDC]);

  // 4. Build transaction
  const tx = new Transaction();
  const recentBlockhash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = recentBlockhash.blockhash;
  tx.feePayer = wallet.publicKey;

  // Compute budget
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
  );

  // Create USDC ATA if needed (WSOL ATA should exist if we have wrapped SOL)
  if (!usdcInfo) {
    const { instruction } = buildCreateATAInstruction(wallet.publicKey, wallet.publicKey, USDC_MINT);
    tx.add(instruction);
    console.log("[executor] Adding create USDC ATA instruction");
  }

  // Create WSOL ATA if needed
  if (!wsolInfo) {
    const { instruction } = buildCreateATAInstruction(wallet.publicKey, wallet.publicKey, WSOL_MINT);
    tx.add(instruction);
    console.log("[executor] Adding create WSOL ATA instruction");
  }

  // Wrap SOL → WSOL (transfer SOL to WSOL ATA, then sync)
  // Need to transfer inputAmount of SOL to the WSOL ATA for the first swap
  tx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: userWSOL,
      lamports: inputAmount.toNumber(),
    })
  );
  // SyncNative to update the WSOL balance
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      keys: [{ pubkey: userWSOL, isSigner: false, isWritable: true }],
      data: Buffer.from([17]), // SyncNative instruction index
    })
  );
  console.log("[executor] Adding SOL→WSOL wrap (" + (inputAmount.toNumber() / LAMPORTS_PER_SOL) + " SOL)");

  // Determine swap directions
  // Both pools: tokenA = SOL, tokenB = USDC
  // "raydium_cheap" means Raydium has lower SOL price -> buy SOL on Raydium, sell on Orca
  //   Swap 1: Orca a→b (sell SOL for USDC on expensive pool)
  //   Swap 2: Raydium b→a (buy SOL with USDC on cheap pool)
  // "orca_cheap" means Orca has lower SOL price -> buy SOL on Orca, sell on Raydium
  //   Swap 1: Raydium a→b (sell SOL for USDC on expensive pool)
  //   Swap 2: Orca b→a (buy SOL with USDC on cheap pool)

  const isRaydiumCheap = direction === "raydium_cheap";

  // --- Swap 1: Sell SOL on the EXPENSIVE pool ---
  if (isRaydiumCheap) {
    // Sell SOL on Orca (a→b)
    const orcaTickArrays = getOrcaTickArrays(
      ORCA_WHIRLPOOL_POOL,
      orcaPool.tickCurrentIndex,
      orcaPool.tickSpacing,
      true // a→b
    );
    const oracle = getOrcaOracleAddress(ORCA_WHIRLPOOL_POOL);

    tx.add(buildOrcaWhirlpoolSwapInstruction({
      tokenAuthority: wallet.publicKey,
      whirlpool: ORCA_WHIRLPOOL_POOL,
      tokenOwnerAccountA: userWSOL,
      tokenVaultA: orcaPool.tokenVaultA,
      tokenOwnerAccountB: userUSDC,
      tokenVaultB: orcaPool.tokenVaultB,
      tickArrays: orcaTickArrays,
      oracle,
      amount: inputAmount,
      otherAmountThreshold: new BN(0), // minimum USDC out (0 for simulation)
      sqrtPriceLimit: MIN_SQRT_PRICE_X64, // a→b price goes down
      amountSpecifiedIsInput: true,
      aToB: true,
    }));
    console.log("[executor] Swap 1: Sell SOL on Orca (a→b)");

    // --- Swap 2: Buy SOL on Raydium with USDC (b→a) ---
    const rayTickArrays = getRaydiumTickArrays(
      RAYDIUM_CLMM_POOL,
      rayPool.tickCurrent,
      rayPool.tickSpacing,
      false // b→a (buying SOL)
    );

    // For b→a swap: input = USDC, output = SOL
    // We use the full USDC balance from swap 1 (use u64::MAX as amount with isBaseInput=false
    // to specify desired output, or use the USDC amount with isBaseInput=true)
    // Simpler: specify exact input = all USDC received. Since we don't know exact amount,
    // we set a large amount and use isBaseInput=true. The amount will be capped by balance.
    // Actually, for atomic execution, we should specify exact input. We'll estimate.
    tx.add(buildRaydiumClmmSwapInstruction({
      payer: wallet.publicKey,
      ammConfig: rayPool.ammConfig,
      poolState: RAYDIUM_CLMM_POOL,
      inputTokenAccount: userUSDC,   // input: USDC
      outputTokenAccount: userWSOL,  // output: SOL
      inputVault: rayPool.vaultB,    // USDC vault
      outputVault: rayPool.vaultA,   // SOL vault
      observationState: rayPool.observationKey,
      tickArrays: rayTickArrays,
      amount: new BN("18446744073709551615"), // u64::MAX = use all available USDC
      otherAmountThreshold: inputAmount.add(minProfitLamports), // minimum SOL back
      sqrtPriceLimitX64: MAX_SQRT_PRICE_X64, // b→a price goes up
      isBaseInput: true,
    }));
    console.log("[executor] Swap 2: Buy SOL on Raydium (b→a)");

  } else {
    // Sell SOL on Raydium (a→b)
    const rayTickArrays = getRaydiumTickArrays(
      RAYDIUM_CLMM_POOL,
      rayPool.tickCurrent,
      rayPool.tickSpacing,
      true // a→b
    );

    tx.add(buildRaydiumClmmSwapInstruction({
      payer: wallet.publicKey,
      ammConfig: rayPool.ammConfig,
      poolState: RAYDIUM_CLMM_POOL,
      inputTokenAccount: userWSOL,   // input: SOL
      outputTokenAccount: userUSDC,  // output: USDC
      inputVault: rayPool.vaultA,    // SOL vault
      outputVault: rayPool.vaultB,   // USDC vault
      observationState: rayPool.observationKey,
      tickArrays: rayTickArrays,
      amount: inputAmount,
      otherAmountThreshold: new BN(0), // minimum USDC out
      sqrtPriceLimitX64: MIN_SQRT_PRICE_X64, // a→b price goes down
      isBaseInput: true,
    }));
    console.log("[executor] Swap 1: Sell SOL on Raydium (a→b)");

    // --- Swap 2: Buy SOL on Orca with USDC (b→a) ---
    const orcaTickArrays = getOrcaTickArrays(
      ORCA_WHIRLPOOL_POOL,
      orcaPool.tickCurrentIndex,
      orcaPool.tickSpacing,
      false // b→a
    );
    const oracle = getOrcaOracleAddress(ORCA_WHIRLPOOL_POOL);

    tx.add(buildOrcaWhirlpoolSwapInstruction({
      tokenAuthority: wallet.publicKey,
      whirlpool: ORCA_WHIRLPOOL_POOL,
      tokenOwnerAccountA: userWSOL,
      tokenVaultA: orcaPool.tokenVaultA,
      tokenOwnerAccountB: userUSDC,
      tokenVaultB: orcaPool.tokenVaultB,
      tickArrays: orcaTickArrays,
      oracle,
      amount: new BN("18446744073709551615"), // u64::MAX = use all USDC
      otherAmountThreshold: inputAmount.add(minProfitLamports), // min SOL back
      sqrtPriceLimit: MAX_SQRT_PRICE_X64, // b→a price goes up
      amountSpecifiedIsInput: true,
      aToB: false,
    }));
    console.log("[executor] Swap 2: Buy SOL on Orca (b→a)");
  }

  // Jito tip
  if (jitoTipLamports > 0) {
    tx.add(buildJitoTipInstruction(wallet.publicKey, jitoTipLamports));
    console.log(`[executor] Jito tip: ${jitoTipLamports} lamports`);
  }

  return { tx, recentBlockhash, rayPool, orcaPool };
}

/**
 * Build arb transaction from an opportunity object (compatibility with main.js).
 */
async function buildArbTransactionFromOpportunity(connection, wallet, opportunity) {
  const { firstPool, secondPool, inputAmount, midAmount, jitoTip, netProfit } = opportunity;

  // Determine direction based on which pool is first (cheaper = buy there)
  // firstPool is where we do first swap (buy intermediate token)
  // For SOL/USDC: if firstPool is Raydium CLMM, we sell USDC for SOL on Raydium first
  // But in the golden pair context, we start with SOL

  // Detect which pool is cheaper for SOL
  const Q64 = new BN(1).shln(64);

  // Read current prices from already-available pool data
  // We'll determine direction in the buildArbTransaction call
  const rayInfo = await connection.getAccountInfo(RAYDIUM_CLMM_POOL);
  const orcaInfo = await connection.getAccountInfo(ORCA_WHIRLPOOL_POOL);

  const raySqrt = Number(readU128(rayInfo.data, 253).toString()) / Math.pow(2, 64);
  const orcaSqrt = Number(readU128(orcaInfo.data, 65).toString()) / Math.pow(2, 64);
  const rayPrice = raySqrt * raySqrt;
  const orcaPrice = orcaSqrt * orcaSqrt;

  const direction = rayPrice < orcaPrice ? "raydium_cheap" : "orca_cheap";
  console.log(`[executor] Ray price=${rayPrice.toFixed(6)}, Orca price=${orcaPrice.toFixed(6)}, direction=${direction}`);

  return buildArbTransaction(connection, wallet, {
    inputAmount,
    minProfitLamports: new BN(1),
    jitoTipLamports: jitoTip.toNumber(),
    direction,
  });
}

/**
 * Submit a transaction via Jito bundle API.
 */
async function submitJitoBundle(connection, signedTx, jitoBlockEngine) {
  const serialized = signedTx.serialize();
  const base58Tx = require("bs58").encode(serialized);

  const bundleUrl = `${jitoBlockEngine}/api/v1/bundles`;

  try {
    const response = await fetch(bundleUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [[base58Tx]],
      }),
    });

    const result = await response.json();

    if (result.error) {
      console.error(`[jito] Bundle rejected: ${JSON.stringify(result.error)}`);
      return { success: false, error: result.error };
    }

    console.log(`[jito] Bundle accepted: ${result.result}`);
    return { success: true, bundleId: result.result };
  } catch (err) {
    console.error(`[jito] Submission failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Execute an arbitrage opportunity end-to-end.
 */
async function executeArb(connection, wallet, opportunity, jitoBlockEngine, dryRun = false) {
  const { netProfit, inputAmount, firstPool, secondPool, jitoTip } = opportunity;

  console.log(`[executor] Executing arb:`);
  console.log(`  Input: ${inputAmount.toString()} lamports`);
  console.log(`  Expected net profit: ${netProfit.toString()} lamports (${netProfit.toNumber() / LAMPORTS_PER_SOL} SOL)`);
  console.log(`  Jito tip: ${jitoTip.toString()} lamports`);

  try {
    const { tx, recentBlockhash } = await buildArbTransactionFromOpportunity(connection, wallet, opportunity);

    if (dryRun) {
      console.log(`[executor] DRY RUN — simulating transaction`);
      const simResult = await connection.simulateTransaction(tx, [wallet]);
      console.log(`[executor] Simulation result:`, simResult.value.err || "SUCCESS");
      if (simResult.value.logs) {
        for (const log of simResult.value.logs.slice(-10)) {
          console.log(`  ${log}`);
        }
      }
      return { success: !simResult.value.err, dryRun: true, simResult: simResult.value };
    }

    // Sign the transaction
    tx.sign(wallet);

    // Submit via Jito
    const result = await submitJitoBundle(connection, tx, jitoBlockEngine);

    if (result.success) {
      console.log(`[executor] Bundle submitted successfully. ID: ${result.bundleId}`);
      await new Promise((r) => setTimeout(r, 2000));
      const balance = await connection.getBalance(wallet.publicKey);
      console.log(`[executor] Current balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    }

    return result;
  } catch (err) {
    console.error(`[executor] Execution failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = {
  // Pool state
  RAYDIUM_CLMM_POOL,
  ORCA_WHIRLPOOL_POOL,
  RAYDIUM_CLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  WSOL_MINT,
  USDC_MINT,
  fetchRaydiumClmmState,
  fetchOrcaWhirlpoolState,
  parseRaydiumClmmPool,
  parseOrcaWhirlpool,
  // Token accounts
  getAssociatedTokenAddress,
  buildCreateATAInstruction,
  // Tick arrays
  getRaydiumTickArrays,
  getOrcaTickArrays,
  getOrcaOracleAddress,
  getTickArrayStartIndex,
  // Swap instructions
  buildRaydiumClmmSwapInstruction,
  buildOrcaWhirlpoolSwapInstruction,
  // Transaction building
  buildArbTransaction,
  buildArbTransactionFromOpportunity,
  // Jito
  buildJitoTipInstruction,
  submitJitoBundle,
  // Execution
  executeArb,
};
