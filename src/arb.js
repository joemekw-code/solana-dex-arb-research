/**
 * Arbitrage detection: compare prices across DEXes, find profitable round-trips.
 */

const BN = require("bn.js");
const { getOutputAmount, WSOL, USDC, USDT } = require("./pools");

/**
 * Given two pools that trade the same pair, find if a round-trip arb exists.
 *
 * Strategy: buy token on poolA, sell on poolB (or vice versa).
 * A round-trip: start with X of tokenA -> swap to tokenB on pool1 -> swap back to tokenA on pool2.
 * Profit = output - input.
 *
 * @param {object} pool1 - First pool state
 * @param {object} pool2 - Second pool state
 * @param {BN} inputAmount - Amount of input token (in smallest unit)
 * @param {number} txFeeLamports - Transaction fee in lamports
 * @param {number} jitoTipBps - Jito tip as basis points of profit (e.g., 5000 = 50%)
 * @returns {object|null} Arb opportunity or null
 */
function findArbOpportunity(pool1, pool2, inputAmount, txFeeLamports = 5000, jitoTipBps = 5000) {
  // Determine common pair orientation
  // pool.coinMint and pool.pcMint define the pair
  // We need to figure out if both pools have the same pair (possibly flipped)

  const p1CoinStr = pool1.coinMint.toBase58();
  const p1PcStr = pool1.pcMint.toBase58();
  const p2CoinStr = pool2.coinMint.toBase58();
  const p2PcStr = pool2.pcMint.toBase58();

  let sameOrientation; // true if coin/pc match, false if flipped
  if (p1CoinStr === p2CoinStr && p1PcStr === p2PcStr) {
    sameOrientation = true;
  } else if (p1CoinStr === p2PcStr && p1PcStr === p2CoinStr) {
    sameOrientation = false;
  } else {
    return null; // Different pairs
  }

  const inputBN = new BN(inputAmount.toString());

  // Direction A: buy coin on pool1 (input pc -> get coin), sell coin on pool2 (input coin -> get pc)
  // Direction B: buy coin on pool2, sell coin on pool1

  // Direction A: pc -> coin via pool1, coin -> pc via pool2
  const midAmountA = getOutputAmount(inputBN, pool1, false); // input is pc (not coin)
  let finalAmountA;
  if (sameOrientation) {
    finalAmountA = getOutputAmount(midAmountA, pool2, true); // input is coin
  } else {
    finalAmountA = getOutputAmount(midAmountA, pool2, false); // in flipped pool, coin of p1 is pc of p2
  }

  // Direction B: pc -> coin via pool2, coin -> pc via pool1
  let midAmountB, finalAmountB;
  if (sameOrientation) {
    midAmountB = getOutputAmount(inputBN, pool2, false);
    finalAmountB = getOutputAmount(midAmountB, pool1, true);
  } else {
    midAmountB = getOutputAmount(inputBN, pool2, true); // flipped: pc of p1 is coin of p2
    finalAmountB = getOutputAmount(midAmountB, pool1, true);
  }

  const profitA = finalAmountA.sub(inputBN);
  const profitB = finalAmountB.sub(inputBN);

  // Pick the better direction
  let bestProfit, bestDirection, bestMidAmount, bestFinalAmount;
  if (profitA.gt(profitB)) {
    bestProfit = profitA;
    bestDirection = "A";
    bestMidAmount = midAmountA;
    bestFinalAmount = finalAmountA;
  } else {
    bestProfit = profitB;
    bestDirection = "B";
    bestMidAmount = midAmountB;
    bestFinalAmount = finalAmountB;
  }

  if (bestProfit.lten(0)) return null;

  // Deduct costs
  const txFee = new BN(txFeeLamports);
  // Jito tip = jitoTipBps/10000 of profit
  const jitoTip = bestProfit.mul(new BN(jitoTipBps)).div(new BN(10000));
  const totalCost = txFee.add(jitoTip);
  const netProfit = bestProfit.sub(totalCost);

  if (netProfit.lten(0)) return null;

  const firstPool = bestDirection === "A" ? pool1 : pool2;
  const secondPool = bestDirection === "A" ? pool2 : pool1;

  return {
    direction: bestDirection,
    firstPool,
    secondPool,
    inputAmount: inputBN,
    midAmount: bestMidAmount,
    finalAmount: bestFinalAmount,
    grossProfit: bestProfit,
    jitoTip,
    txFee,
    netProfit,
    firstSwapInputIsCoin: false, // start with pc token
    secondSwapInputIsCoin: sameOrientation || bestDirection === "A",
  };
}

/**
 * Scan multiple input amounts to find the optimal trade size.
 * Larger trades have more slippage, so there's a sweet spot.
 */
function findOptimalArbSize(pool1, pool2, baseAmounts, txFeeLamports = 5000, jitoTipBps = 5000) {
  let bestOpp = null;

  for (const amount of baseAmounts) {
    const opp = findArbOpportunity(pool1, pool2, amount, txFeeLamports, jitoTipBps);
    if (opp && (!bestOpp || opp.netProfit.gt(bestOpp.netProfit))) {
      bestOpp = opp;
    }
  }

  return bestOpp;
}

/**
 * Generate a range of input amounts to test.
 * For SOL-denominated pairs, we test from 0.001 SOL to available balance.
 */
function generateTestAmounts(maxLamports) {
  const amounts = [];
  // Test: 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0 SOL (capped by balance)
  const steps = [5000000, 10000000, 20000000, 50000000, 100000000, 200000000, 500000000, 1000000000];
  for (const s of steps) {
    if (s <= maxLamports) amounts.push(new BN(s));
  }
  // Also test the max
  if (maxLamports > 5000000) {
    amounts.push(new BN(Math.floor(maxLamports * 0.8))); // 80% of balance
  }
  return amounts;
}

/**
 * Build all possible pool pairs from a list of pool states.
 * Only pairs that share the same token pair.
 */
function buildPoolPairs(pools) {
  const pairs = [];
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      const p1 = pools[i];
      const p2 = pools[j];
      const p1Coins = [p1.coinMint.toBase58(), p1.pcMint.toBase58()].sort().join("/");
      const p2Coins = [p2.coinMint.toBase58(), p2.pcMint.toBase58()].sort().join("/");
      if (p1Coins === p2Coins) {
        pairs.push([p1, p2]);
      }
    }
  }
  return pairs;
}

module.exports = {
  findArbOpportunity,
  findOptimalArbSize,
  generateTestAmounts,
  buildPoolPairs,
};
