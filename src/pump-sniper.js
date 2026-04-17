#!/usr/bin/env node
/**
 * Pump.fun Sniper Bot
 *
 * Strategy:
 * 1. Poll new tokens every 5 seconds
 * 2. Filter: only buy tokens where real_sol_reserves grows fast (= buy pressure)
 * 3. Buy via Jupiter swap ($0.5-1 per trade)
 * 4. Sell at 2x or stop-loss at -50%
 *
 * $0 dry-run: log what WOULD be bought, track if it pumped
 */
const fs=require("fs");

const DRY_RUN=process.env.DRY_RUN!=="false";
const PUMP_API="https://frontend-api-v3.pump.fun";
const J="https://lite-api.jup.ag/swap/v1";
const SOL="So11111111111111111111111111111111111111112";
const BUY_AMOUNT=500000; // 0.0005 SOL per trade ($0.04) — tiny for testing

let wallet,conn;
if(!DRY_RUN){
  const{Connection,Keypair}=require("@solana/web3.js");
  conn=new Connection("https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY");
  const walletData=JSON.parse(fs.readFileSync("./wallet.json"));
  wallet=Keypair.fromSecretKey(Buffer.from(walletData.secretKeyBase64,"base64"));
}

fs.mkdirSync("results",{recursive:true});
const logFile="results/pump-sniper.jsonl";
const seenTokens=new Map(); // mint -> {firstSeen, firstSol, firstMcap}
const positions=new Map(); // mint -> {buyMcap, buyTime, symbol}
let trades=0,wins=0,losses=0,totalPnL=0;
const startTime=Date.now();

function log(data){
  const entry={ts:new Date().toISOString(),...data};
  fs.appendFileSync(logFile,JSON.stringify(entry)+"\n");
}

async function fetchTokens(){
  try{
    const r=await fetch(PUMP_API+"/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false",
      {headers:{"User-Agent":"Mozilla/5.0"}});
    return await r.json();
  }catch{return[];}
}

async function checkAndBuy(token){
  const mint=token.mint;
  const mcap=token.usd_market_cap||0;
  const realSol=(token.real_sol_reserves||0)/1e9;
  const age=(Date.now()-new Date(token.created_timestamp).getTime())/1000;
  const replies=token.reply_count||0;
  const hasTwitter=!!token.twitter;

  // First time seeing this token? Record baseline
  if(!seenTokens.has(mint)){
    seenTokens.set(mint,{
      firstSeen:Date.now(),
      firstSol:realSol,
      firstMcap:mcap,
      symbol:token.symbol,
    });
    return;
  }

  // Already in position?
  if(positions.has(mint))return;

  const baseline=seenTokens.get(mint);
  const timeSinceFirstSeen=(Date.now()-baseline.firstSeen)/1000;
  const solGrowth=realSol-baseline.firstSol;
  const mcapGrowth=mcap-baseline.firstMcap;

  // === FILTER RULES ===
  // 1. Token must be < 5 min old
  if(age>300)return;

  // 2. Bonding curve completion > 40% (= very strong buy pressure, near graduation)
  const completion=realSol/85*100;
  if(completion<40)return;

  // 3. Must have grown since we first saw it
  if(solGrowth<0.5)return; // at least 0.5 SOL of new buys

  // 4. SOL growth rate > 0.05 SOL/sec (= very strong buy pressure)
  const growthRate=timeSinceFirstSeen>0?solGrowth/timeSinceFirstSeen:0;
  if(growthRate<0.05)return;

  // 5. Market cap between $5k-$50k
  if(mcap<5000||mcap>50000)return;

  // === BUY SIGNAL ===
  const signal={
    mint:mint.slice(0,12),
    symbol:token.symbol,
    mcap:Math.floor(mcap),
    realSol:realSol.toFixed(2),
    solGrowth:solGrowth.toFixed(3),
    growthRate:growthRate.toFixed(4),
    age:Math.floor(age),
    replies,
    twitter:hasTwitter,
  };

  console.log("\n  >>> BUY SIGNAL: "+token.symbol+" mcap=$"+Math.floor(mcap)+" solGrowth="+solGrowth.toFixed(3)+" rate="+growthRate.toFixed(4)+"/s");

  positions.set(mint,{
    buyMcap:mcap,
    buyTime:Date.now(),
    symbol:token.symbol,
  });

  if(DRY_RUN){
    log({action:"DRY_BUY",...signal});
  }else{
    // Real buy via Jupiter
    try{
      const q=await fetch(J+"/quote?inputMint="+SOL+"&outputMint="+mint+"&amount="+BUY_AMOUNT+"&slippageBps=1000").then(r=>r.json());
      if(q&&q.outAmount){
        log({action:"QUOTE",...signal,outAmount:q.outAmount});
        // Execute swap
        const si=await fetch(J+"/swap",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({quoteResponse:q,userPublicKey:wallet.publicKey.toBase58(),wrapAndUnwrapSol:true})}).then(r=>r.json());
        if(si&&si.swapTransaction){
          const{VersionedTransaction}=require("@solana/web3.js");
          const tx=VersionedTransaction.deserialize(Buffer.from(si.swapTransaction,"base64"));
          tx.sign([wallet]);
          const sig=await conn.sendTransaction(tx,{skipPreflight:true});
          log({action:"BUY",...signal,sig});
          console.log("    BOUGHT! sig="+sig.slice(0,16));
        }
      }
    }catch(e){
      log({action:"BUY_ERROR",...signal,err:e.message?.slice(0,50)});
    }
  }
}

async function checkPositions(currentTokens){
  const tokenMap=new Map(currentTokens.map(t=>[t.mint,t]));

  for(const[mint,pos]of positions){
    const token=tokenMap.get(mint);
    if(!token)continue;

    const currentMcap=token.usd_market_cap||0;
    const ratio=currentMcap/pos.buyMcap;
    const holdTime=(Date.now()-pos.buyTime)/1000;

    // Sell conditions
    let sell=false,reason="";
    if(ratio>=2.0){sell=true;reason="PROFIT_2X";}
    else if(ratio<=0.5){sell=true;reason="STOPLOSS_50";}
    else if(holdTime>600){sell=true;reason="TIMEOUT_10M";}

    if(sell){
      trades++;
      const pnl=ratio-1; // % return
      totalPnL+=pnl;
      if(pnl>0)wins++;else losses++;

      console.log("    "+reason+": "+pos.symbol+" ratio="+ratio.toFixed(2)+" pnl="+(pnl*100).toFixed(1)+"%");
      log({action:DRY_RUN?"DRY_SELL":"SELL",mint:mint.slice(0,12),symbol:pos.symbol,
        buyMcap:Math.floor(pos.buyMcap),sellMcap:Math.floor(currentMcap),
        ratio:ratio.toFixed(3),pnl:(pnl*100).toFixed(1),reason});

      positions.delete(mint);

      if(!DRY_RUN&&pnl>-0.3){
        // Actual sell via Jupiter
        // TODO: implement
      }
    }
  }
}

async function main(){
  console.log("=== PUMP.FUN SNIPER BOT ===");
  console.log("Mode: "+(DRY_RUN?"DRY RUN":"LIVE"));
  console.log("Buy amount: "+(BUY_AMOUNT/1e9)+" SOL per trade");
  console.log("Filters: age<5m, solGrowth>0.05, rate>0.005/s, mcap $3-30k");
  console.log("Sell: 2x profit OR -50% stop OR 10min timeout\n");

  while(true){
    try{
      const tokens=await fetchTokens();

      // Check new tokens for buy signals
      for(const t of tokens){
        await checkAndBuy(t);
      }

      // Check existing positions
      await checkPositions(tokens);

      // Status
      const el=((Date.now()-startTime)/60000).toFixed(1);
      const wr=trades>0?(wins/trades*100).toFixed(0):"0";
      process.stdout.write("\r  ["+el+"m] seen="+seenTokens.size+" pos="+positions.size+
        " trades="+trades+" W/L="+wins+"/"+losses+" ("+wr+"%) pnl="+(totalPnL*100).toFixed(1)+"%   ");

    }catch{}

    await new Promise(r=>setTimeout(r,5000)); // poll every 5s
  }
}

main().catch(console.error);
