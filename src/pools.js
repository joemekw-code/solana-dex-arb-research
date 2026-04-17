/**
 * Direct on-chain pool state reading for Raydium AMM and Orca Whirlpool.
 * FIXED: Orca uses sqrtPrice CLMM math, not vault-balance constant product.
 */

const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");

// --- Token account parsing ---
function parseTokenAccountBalance(data) {
  return new BN(data.slice(64, 72), "le");
}
function readU64(data, offset) { return new BN(data.slice(offset, offset + 8), "le"); }
function readU128(data, offset) { return new BN(data.slice(offset, offset + 16), "le"); }
function readPubkey(data, offset) { return new PublicKey(data.slice(offset, offset + 32)); }
function readI32(data, offset) { return data.readInt32LE(offset); }
function readU16(data, offset) { return data.readUInt16LE(offset); }

// --- Raydium AMM V4 ---
const RAYDIUM_AMM_PROGRAM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

const RAY_LAYOUT = {
  status: 0, coinDecimals: 32, pcDecimals: 40,
  tradeFeeNumerator: 144, tradeFeeDenominator: 152,
  swapFeeNumerator: 176, swapFeeDenominator: 184,
  poolCoinTokenAccount: 336, poolPcTokenAccount: 368,
  coinMintAddress: 400, pcMintAddress: 432,
  ammOpenOrders: 496, serumMarket: 528, serumProgramId: 560,
  ammTargetOrders: 592,
};

function parseRaydiumPool(data) {
  const L = RAY_LAYOUT;
  return {
    status: readU64(data, L.status).toNumber(),
    coinDecimals: readU64(data, L.coinDecimals).toNumber(),
    pcDecimals: readU64(data, L.pcDecimals).toNumber(),
    tradeFeeNumerator: readU64(data, L.tradeFeeNumerator),
    tradeFeeDenominator: readU64(data, L.tradeFeeDenominator),
    poolCoinTokenAccount: readPubkey(data, L.poolCoinTokenAccount),
    poolPcTokenAccount: readPubkey(data, L.poolPcTokenAccount),
    coinMintAddress: readPubkey(data, L.coinMintAddress),
    pcMintAddress: readPubkey(data, L.pcMintAddress),
    ammOpenOrders: readPubkey(data, L.ammOpenOrders),
    serumMarket: readPubkey(data, L.serumMarket),
    serumProgramId: readPubkey(data, L.serumProgramId),
    ammTargetOrders: readPubkey(data, L.ammTargetOrders),
  };
}

async function fetchRaydiumPoolState(connection, poolAddress) {
  const poolPubkey = typeof poolAddress === "string" ? new PublicKey(poolAddress) : poolAddress;
  const poolInfo = await connection.getAccountInfo(poolPubkey);
  if (!poolInfo) throw new Error(`Pool not found: ${poolPubkey.toBase58()}`);
  const pool = parseRaydiumPool(poolInfo.data);
  if (pool.status !== 6 && pool.status !== 1) return null;

  const [coinVaultInfo, pcVaultInfo] = await connection.getMultipleAccountsInfo([
    pool.poolCoinTokenAccount, pool.poolPcTokenAccount,
  ]);
  if (!coinVaultInfo || !pcVaultInfo) throw new Error("Vault accounts not found");

  return {
    address: poolPubkey,
    dex: "raydium",
    type: "amm", // constant product
    coinMint: pool.coinMintAddress,
    pcMint: pool.pcMintAddress,
    coinReserve: parseTokenAccountBalance(coinVaultInfo.data),
    pcReserve: parseTokenAccountBalance(pcVaultInfo.data),
    coinDecimals: pool.coinDecimals,
    pcDecimals: pool.pcDecimals,
    feeNumerator: pool.tradeFeeNumerator,
    feeDenominator: pool.tradeFeeDenominator,
    poolCoinTokenAccount: pool.poolCoinTokenAccount,
    poolPcTokenAccount: pool.poolPcTokenAccount,
    ammOpenOrders: pool.ammOpenOrders,
    serumMarket: pool.serumMarket,
    serumProgramId: pool.serumProgramId,
    ammTargetOrders: pool.ammTargetOrders,
  };
}

// --- Orca Whirlpool (CLMM) ---
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

const WP_LAYOUT = {
  discriminator: 0, whirlpoolsConfig: 8, whirlpoolBump: 40,
  tickSpacing: 41, tickSpacingSeed: 43,
  feeRate: 45, // u16, hundredths of a bip (so 3000 = 0.3%)
  protocolFeeRate: 47,
  liquidity: 49, // u128
  sqrtPrice: 65, // u128 (Q64.64 fixed point)
  tickCurrentIndex: 81,
  tokenMintA: 101, tokenVaultA: 133,
  tokenMintB: 181, tokenVaultB: 213,
};

function parseWhirlpool(data) {
  return {
    tickSpacing: readU16(data, WP_LAYOUT.tickSpacing),
    feeRate: readU16(data, WP_LAYOUT.feeRate),
    liquidity: readU128(data, WP_LAYOUT.liquidity),
    sqrtPrice: readU128(data, WP_LAYOUT.sqrtPrice),
    tickCurrentIndex: readI32(data, WP_LAYOUT.tickCurrentIndex),
    tokenMintA: readPubkey(data, WP_LAYOUT.tokenMintA),
    tokenVaultA: readPubkey(data, WP_LAYOUT.tokenVaultA),
    tokenMintB: readPubkey(data, WP_LAYOUT.tokenMintB),
    tokenVaultB: readPubkey(data, WP_LAYOUT.tokenVaultB),
  };
}

async function fetchWhirlpoolState(connection, poolAddress) {
  const poolPubkey = typeof poolAddress === "string" ? new PublicKey(poolAddress) : poolAddress;
  const poolInfo = await connection.getAccountInfo(poolPubkey);
  if (!poolInfo) throw new Error(`Whirlpool not found: ${poolPubkey.toBase58()}`);
  const pool = parseWhirlpool(poolInfo.data);

  // Get vault balances for reference (but NOT used for price calculation)
  const [vaultAInfo, vaultBInfo] = await connection.getMultipleAccountsInfo([
    pool.tokenVaultA, pool.tokenVaultB,
  ]);
  const reserveA = vaultAInfo ? parseTokenAccountBalance(vaultAInfo.data) : new BN(0);
  const reserveB = vaultBInfo ? parseTokenAccountBalance(vaultBInfo.data) : new BN(0);

  return {
    address: poolPubkey,
    dex: "orca",
    type: "clmm", // concentrated liquidity
    coinMint: pool.tokenMintA,
    pcMint: pool.tokenMintB,
    coinReserve: reserveA, // for reference only
    pcReserve: reserveB,
    sqrtPrice: pool.sqrtPrice,
    liquidity: pool.liquidity,
    tickCurrentIndex: pool.tickCurrentIndex,
    feeRate: pool.feeRate,
    tokenVaultA: pool.tokenVaultA,
    tokenVaultB: pool.tokenVaultB,
  };
}

// --- Swap math ---

// Raydium AMM: constant product
function calcConstantProductOutput(amountIn, reserveIn, reserveOut, feeNumerator, feeDenominator) {
  const amtIn = new BN(amountIn.toString());
  const resIn = new BN(reserveIn.toString());
  const resOut = new BN(reserveOut.toString());
  const feeNum = new BN(feeNumerator.toString());
  const feeDenom = new BN(feeDenominator.toString());
  const amtWithFee = amtIn.mul(feeDenom.sub(feeNum));
  const num = resOut.mul(amtWithFee);
  const denom = resIn.mul(feeDenom).add(amtWithFee);
  if (denom.isZero()) return new BN(0);
  return num.div(denom);
}

// Orca CLMM: use sqrtPrice and liquidity for single-tick swap
// sqrtPrice is Q64.64 format: actual_sqrt_price = sqrtPrice / 2^64
// For a→b (selling tokenA for tokenB):
//   delta_b = liquidity * (sqrt_price_current - sqrt_price_after)
//   delta_a = liquidity * (1/sqrt_price_after - 1/sqrt_price_current)
// Simplified for small swaps within a single tick:
//   price_a_in_b = (sqrtPrice / 2^64)^2
//   amountOut ≈ amountIn * price * (1 - feeRate/1e6)
function calcClmmOutput(amountIn, pool, aToB) {
  const amtIn = new BN(amountIn.toString());
  const sqrtP = pool.sqrtPrice;
  const liq = pool.liquidity;

  if (liq.isZero() || sqrtP.isZero()) return new BN(0);

  // Fee: feeRate is in hundredths of a bip = 1e-6 units
  // So feeRate=3000 means 0.3%
  const FEE_DENOM = new BN(1000000);
  const feeMultiplier = FEE_DENOM.sub(new BN(pool.feeRate));
  const amtAfterFee = amtIn.mul(feeMultiplier).div(FEE_DENOM);

  // Price calculation using sqrtPrice (Q64.64)
  // price = (sqrtPrice / 2^64)^2 = sqrtPrice^2 / 2^128
  // For a→b: amountOut = amountIn * price
  // For b→a: amountOut = amountIn / price

  // Use high-precision: multiply first, then divide
  const Q64 = new BN(1).shln(64);
  const Q128 = new BN(1).shln(128);

  if (aToB) {
    // Selling A for B: out_b = amt_a * sqrtP^2 / 2^128
    // To avoid overflow with large numbers, do: (amt * sqrtP / 2^64) * sqrtP / 2^64
    const step1 = amtAfterFee.mul(sqrtP).div(Q64);
    const out = step1.mul(sqrtP).div(Q64);
    return out;
  } else {
    // Selling B for A: out_a = amt_b * 2^128 / sqrtP^2
    // = (amt * 2^64 / sqrtP) * 2^64 / sqrtP
    if (sqrtP.isZero()) return new BN(0);
    const step1 = amtAfterFee.mul(Q64).div(sqrtP);
    const out = step1.mul(Q64).div(sqrtP);
    return out;
  }
}

function getOutputAmount(amountIn, pool, inputIsCoin) {
  if (pool.type === "amm" || pool.dex === "raydium") {
    const resIn = inputIsCoin ? pool.coinReserve : pool.pcReserve;
    const resOut = inputIsCoin ? pool.pcReserve : pool.coinReserve;
    return calcConstantProductOutput(amountIn, resIn, resOut, pool.feeNumerator, pool.feeDenominator);
  } else if (pool.type === "clmm" || pool.dex === "orca") {
    return calcClmmOutput(amountIn, pool, inputIsCoin);
  }
  throw new Error(`Unknown pool type: ${pool.type}`);
}

// --- Known pool addresses ---
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

const KNOWN_RAYDIUM_POOLS = [
  "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", // SOL/USDC
  "7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX", // SOL/USDT
  "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA", // RAY/SOL
  "6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg", // RAY/USDC
];

const KNOWN_ORCA_POOLS = [
  "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ", // SOL/USDC (tick spacing 64)
];

async function fetchAllPools(connection) {
  const pools = [];
  const errors = [];

  for (const addr of KNOWN_RAYDIUM_POOLS) {
    try {
      const state = await fetchRaydiumPoolState(connection, addr);
      if (state) pools.push(state);
    } catch (e) { errors.push(`Raydium ${addr.slice(0,8)}: ${e.message}`); }
  }

  for (const addr of KNOWN_ORCA_POOLS) {
    try {
      const state = await fetchWhirlpoolState(connection, addr);
      if (state) pools.push(state);
    } catch (e) { errors.push(`Orca ${addr.slice(0,8)}: ${e.message}`); }
  }

  if (errors.length > 0) {
    console.log(`[pools] Errors: ${errors.join("; ")}`);
  }

  return pools;
}

function printPoolSummary(pools) {
  for (const p of pools) {
    const id = p.address.toBase58().slice(0, 12);
    if (p.type === "amm") {
      const coinRes = p.coinReserve.toString();
      const pcRes = p.pcReserve.toString();
      const price = Number(pcRes) / Number(coinRes) * Math.pow(10, p.coinDecimals - p.pcDecimals);
      console.log(`  ${p.dex}(AMM) ${id} price=${price.toFixed(4)} coin=${coinRes} pc=${pcRes}`);
    } else {
      const Q64 = Math.pow(2, 64);
      const sqrtP = Number(p.sqrtPrice.toString()) / Q64;
      const price = sqrtP * sqrtP;
      console.log(`  ${p.dex}(CLMM) ${id} price=${price.toFixed(4)} sqrtP=${sqrtP.toFixed(8)} liq=${p.liquidity.toString().slice(0,10)}...`);
    }
  }
}

module.exports = {
  RAYDIUM_AMM_PROGRAM, ORCA_WHIRLPOOL_PROGRAM,
  WSOL, USDC, USDT,
  KNOWN_RAYDIUM_POOLS, KNOWN_ORCA_POOLS,
  fetchRaydiumPoolState, fetchWhirlpoolState, fetchAllPools,
  getOutputAmount, calcConstantProductOutput, calcClmmOutput,
  printPoolSummary,
};
