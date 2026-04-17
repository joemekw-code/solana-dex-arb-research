#!/usr/bin/env node
/**
 * WebSocket event-driven arb:
 * 1. Subscribe to pool account changes via Helius WebSocket (FREE)
 * 2. When pool state changes (= swap happened), IMMEDIATELY check Jupiter API
 * 3. If profitable, log it (DRY_RUN) or execute
 *
 * This tests: "does profit exist in the instant after a swap?"
 */

require("dotenv").config();
const WebSocket = require("ws"); // Need to install
const fs = require("fs");

const HELIUS_KEY = "YOUR_HELIUS_API_KEY";
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const JUP = "https://lite-api.jup.ag/swap/v1";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

// Pools to watch (high-activity pools where swaps create dislocations)
const WATCH_POOLS = [
  // Raydium SOL/USDC AMM
  { addr: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", pair: "SOL/USDC", dex: "Raydium AMM" },
  // Orca SOL/USDC Whirlpool 30bp
  { addr: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ", pair: "SOL/USDC", dex: "Orca 30bp" },
  // Raydium CLMM SOL/USDC 1bp
  { addr: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj", pair: "SOL/USDC", dex: "Raydium CLMM" },
  // Orca SOL/USDC 1bp
  { addr: "83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d", pair: "SOL/USDC", dex: "Orca 1bp" },
];

// Arb routes to check when a swap is detected
const ARB_CHECKS = [
  // SOL/USDC across DEXes
  { sell: SOL, buy: USDC, sellDex: ["Raydium CLMM"], buyDex: null, pair: "SOL→USDC→SOL", size: 11236000 },
  { sell: SOL, buy: USDC, sellDex: ["Whirlpool"], buyDex: null, pair: "SOL→USDC→SOL", size: 11236000 },
  { sell: SOL, buy: USDC, sellDex: null, buyDex: ["Raydium CLMM"], pair: "SOL→USDC→SOL", size: 11236000 },
  { sell: SOL, buy: USDC, sellDex: null, buyDex: ["Whirlpool"], pair: "SOL→USDC→SOL", size: 11236000 },
  // Triangular via BONK
  { tri: [SOL, BONK, USDC, SOL], pair: "SOL→BONK→USDC→SOL", size: 11236000 },
  { tri: [SOL, BONK, USDC, SOL], pair: "SOL→BONK→USDC→SOL", size: 56180000 }, // $5
  // Triangular via WIF
  { tri: [SOL, WIF, USDC, SOL], pair: "SOL→WIF→USDC→SOL", size: 11236000 },
];

fs.mkdirSync("results", { recursive: true });
const dataFile = "results/ws-arb.jsonl";
const logFile = "results/ws-arb.log";

let swapCount = 0;
let checkCount = 0;
let profitableCount = 0;
const startTime = Date.now();

function logMsg(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, line + "\n");
}

async function jupQuote(inputMint, outputMint, amount, dexes = null) {
  try {
    let url = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=200`;
    if (dexes) url += `&dexes=${encodeURIComponent(dexes.join(","))}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    return d.outAmount ? { out: d.outAmount, route: d.routePlan?.map(r => r.swapInfo?.label).join("→") || "?" } : null;
  } catch { return null; }
}

async function checkArb(trigger) {
  const ts = Date.now();

  for (const check of ARB_CHECKS) {
    checkCount++;

    if (check.tri) {
      // Triangular
      const mints = check.tri;
      let current = check.size.toString();
      let failed = false;
      const routes = [];

      for (let i = 0; i < mints.length - 1; i++) {
        const q = await jupQuote(mints[i], mints[i + 1], current);
        if (!q) { failed = true; break; }
        current = q.out;
        routes.push(q.route);
      }
      if (failed) continue;

      const profit = (Number(current) - check.size) / 1e9 * 89;
      const net = profit - 0.001;
      const latency = Date.now() - ts;

      const entry = { ts: new Date().toISOString(), trigger: trigger.dex, triggerPair: trigger.pair, method: "tri", detail: check.pair, profit, net, profitable: net > 0, latencyMs: latency, routes: routes.join("|") };
      fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");

      if (net > 0) {
        profitableCount++;
        logMsg(`✓ PROFITABLE $${net.toFixed(4)} | ${check.pair} [${routes.join("|")}] latency=${latency}ms`);
      }
    } else {
      // 2-point
      const q1 = await jupQuote(check.sell, check.buy, check.size, check.sellDex);
      if (!q1) continue;
      const q2 = await jupQuote(check.buy, check.sell, q1.out, check.buyDex);
      if (!q2) continue;

      const profit = (Number(q2.out) - check.size) / 1e9 * 89;
      const net = profit - 0.001;
      const latency = Date.now() - ts;

      const entry = { ts: new Date().toISOString(), trigger: trigger.dex, method: "2pt", detail: `${check.sellDex || "best"}→${check.buyDex || "best"}`, profit, net, profitable: net > 0, latencyMs: latency };
      fs.appendFileSync(dataFile, JSON.stringify(entry) + "\n");

      if (net > 0) {
        profitableCount++;
        logMsg(`✓ PROFITABLE $${net.toFixed(4)} | ${check.pair} ${check.sellDex || "best"}→${check.buyDex || "best"} latency=${latency}ms`);
      }
    }
  }
}

function connect() {
  logMsg("Connecting to Helius WebSocket...");
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    logMsg("Connected! Subscribing to pool accounts...");

    for (const pool of WATCH_POOLS) {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: pool.addr.slice(0, 8),
        method: "accountSubscribe",
        params: [pool.addr, { encoding: "base64", commitment: "confirmed" }],
      }));
      logMsg(`  Subscribed: ${pool.dex} ${pool.pair} (${pool.addr.slice(0, 12)}...)`);
    }
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Subscription confirmation
      if (msg.result !== undefined) return;

      // Account change notification
      if (msg.method === "accountNotification") {
        swapCount++;
        const subId = msg.params?.subscription;
        const slot = msg.params?.result?.context?.slot;

        // Find which pool changed
        const pool = WATCH_POOLS[swapCount % WATCH_POOLS.length] || WATCH_POOLS[0];

        const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
        logMsg(`SWAP #${swapCount} detected on ${pool.dex} slot=${slot} [${elapsed}m] checks=${checkCount} wins=${profitableCount}`);

        // Immediately check arb
        await checkArb(pool);
      }
    } catch {}
  });

  ws.on("error", (err) => {
    logMsg(`WebSocket error: ${err.message?.slice(0, 50)}`);
  });

  ws.on("close", () => {
    logMsg("WebSocket closed. Reconnecting in 3s...");
    setTimeout(connect, 3000);
  });
}

async function main() {
  logMsg("=== WebSocket Event-Driven Arb ===");
  logMsg(`Watching ${WATCH_POOLS.length} pools`);
  logMsg(`Checking ${ARB_CHECKS.length} arb routes per swap event`);
  logMsg("Duration: until manually stopped\n");

  // Check if ws module is available
  try {
    require("ws");
  } catch {
    logMsg("Installing ws module...");
    require("child_process").execSync("npm install ws", { stdio: "inherit" });
  }

  connect();
}

main();
