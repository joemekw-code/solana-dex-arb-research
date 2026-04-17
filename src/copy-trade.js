#!/usr/bin/env node
/**
 * Copy-Trade Bot
 * 1. Monitor profitable wallets via WebSocket
 * 2. When they buy a token, auto-buy the same token
 * 3. Auto-sell at profit target or stop-loss
 */
require("dotenv").config();
const WebSocket=require("ws");
const{Connection,PublicKey,Keypair,LAMPORTS_PER_SOL}=require("@solana/web3.js");
const fs=require("fs");

const KEY="YOUR_HELIUS_API_KEY";
const conn=new Connection(`https://mainnet.helius-rpc.com/?api-key=${KEY}`);
const J="https://lite-api.jup.ag/swap/v1";
const SOL="So11111111111111111111111111111111111111112";

// Load wallet
const walletData=JSON.parse(fs.readFileSync("./wallet.json"));
const wallet=Keypair.fromSecretKey(Buffer.from(walletData.secretKeyBase64,"base64"));

// Config
const DRY_RUN=process.env.DRY_RUN!=="false"; // default: dry run
const BUY_AMOUNT=1000000; // 0.001 SOL per copy trade ($0.09)
const PROFIT_TARGET=1.10; // sell at 10% profit
const STOP_LOSS=0.90; // sell at 10% loss
const MAX_HOLD_MS=5*60*1000; // max hold 5 minutes

// Target wallets to copy (found from analysis)
const TARGETS=[
  "2BxmGHGv6XKCCQdf5b3vUMKuj5P9XKQqLEpaLeCMDTaW", // +5.87 SOL/6min, 144 SOL
  "B2aCkCrALAbCCGgYVyJpciTwoYNqVD3g2QgBpTyTRdgX", // 100% win rate, JUP trader
];

fs.mkdirSync("results",{recursive:true});
const logFile="results/copy-trade.jsonl";
const positions=new Map(); // mint -> {buyPrice, amount, time}
let trades=0,wins=0,totalPnL=0;

function log(data){
  const entry={ts:new Date().toISOString(),...data};
  fs.appendFileSync(logFile,JSON.stringify(entry)+"\n");
  console.log(JSON.stringify(entry));
}

async function sf(u,o){
  for(let i=0;i<2;i++){
    try{
      const r=await fetch(u,o);
      if(r.ok)return await r.json();
      if(r.status===429){await new Promise(r=>setTimeout(r,1500));continue;}
    }catch{}
  }
  return null;
}

async function getTokenPrice(mint){
  const q=await sf(J+"/quote?inputMint="+mint+"&outputMint="+SOL+"&amount=1000000&slippageBps=300");
  if(!q||!q.outAmount)return null;
  return Number(q.outAmount)/1000000; // lamports per unit
}

async function buyToken(mint,amount){
  // Buy token with SOL via Jupiter
  const q=await sf(J+"/quote?inputMint="+SOL+"&outputMint="+mint+"&amount="+amount+"&slippageBps=300");
  if(!q||!q.outAmount)return null;

  if(DRY_RUN){
    log({action:"DRY_BUY",mint:mint.slice(0,12),solIn:amount,tokenOut:q.outAmount,price:(amount/Number(q.outAmount)).toFixed(8)});
    return{tokenAmount:Number(q.outAmount),price:amount/Number(q.outAmount)};
  }

  // Real execution via Jupiter swap
  const si=await sf(J+"/swap",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({quoteResponse:q,userPublicKey:wallet.publicKey.toBase58(),wrapAndUnwrapSol:true})});
  if(!si||si.error)return null;

  // Sign and send
  const{VersionedTransaction}=require("@solana/web3.js");
  const tx=VersionedTransaction.deserialize(Buffer.from(si.swapTransaction,"base64"));
  tx.sign([wallet]);
  const sig=await conn.sendTransaction(tx,{skipPreflight:true});
  log({action:"BUY",mint:mint.slice(0,12),solIn:amount,tokenOut:q.outAmount,sig});
  return{tokenAmount:Number(q.outAmount),price:amount/Number(q.outAmount)};
}

async function sellToken(mint,tokenAmount,reason){
  const q=await sf(J+"/quote?inputMint="+mint+"&outputMint="+SOL+"&amount="+tokenAmount+"&slippageBps=500");
  if(!q||!q.outAmount)return null;

  if(DRY_RUN){
    log({action:"DRY_SELL",mint:mint.slice(0,12),tokenIn:tokenAmount,solOut:q.outAmount,reason});
    return Number(q.outAmount);
  }

  const si=await sf(J+"/swap",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({quoteResponse:q,userPublicKey:wallet.publicKey.toBase58(),wrapAndUnwrapSol:true})});
  if(!si||si.error)return null;

  const{VersionedTransaction}=require("@solana/web3.js");
  const tx=VersionedTransaction.deserialize(Buffer.from(si.swapTransaction,"base64"));
  tx.sign([wallet]);
  const sig=await conn.sendTransaction(tx,{skipPreflight:true});
  log({action:"SELL",mint:mint.slice(0,12),tokenIn:tokenAmount,solOut:q.outAmount,reason,sig});
  return Number(q.outAmount);
}

async function checkPositions(){
  for(const[mint,pos]of positions){
    try{
      const currentPrice=await getTokenPrice(mint);
      if(!currentPrice)continue;

      const ratio=currentPrice/pos.price;
      const holdTime=Date.now()-pos.time;

      if(ratio>=PROFIT_TARGET){
        const solOut=await sellToken(mint,pos.amount,"PROFIT");
        if(solOut){
          const pnl=solOut-BUY_AMOUNT;
          trades++;wins++;totalPnL+=pnl;
          log({action:"CLOSED",mint:mint.slice(0,12),pnl,ratio:ratio.toFixed(4),reason:"PROFIT"});
          positions.delete(mint);
        }
      }else if(ratio<=STOP_LOSS){
        const solOut=await sellToken(mint,pos.amount,"STOPLOSS");
        if(solOut){
          const pnl=solOut-BUY_AMOUNT;
          trades++;totalPnL+=pnl;
          log({action:"CLOSED",mint:mint.slice(0,12),pnl,ratio:ratio.toFixed(4),reason:"STOPLOSS"});
          positions.delete(mint);
        }
      }else if(holdTime>MAX_HOLD_MS){
        const solOut=await sellToken(mint,pos.amount,"TIMEOUT");
        if(solOut){
          const pnl=solOut-BUY_AMOUNT;
          trades++;if(pnl>0)wins++;totalPnL+=pnl;
          log({action:"CLOSED",mint:mint.slice(0,12),pnl,ratio:ratio.toFixed(4),reason:"TIMEOUT"});
          positions.delete(mint);
        }
      }
    }catch{}
  }
}

// Parse transaction to find what token the target wallet bought
async function parseTargetTx(sig,targetWallet){
  try{
    const tx=await conn.getTransaction(sig,{maxSupportedTransactionVersion:0});
    if(!tx||tx.meta.err)return null;

    // Check post token balances for new tokens (buy = gaining new token)
    const post=tx.meta.postTokenBalances||[];
    const pre=tx.meta.preTokenBalances||[];

    const keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses});

    // Find token balance increases for the target wallet
    for(const p of post){
      if(keys.get(p.accountIndex).toBase58()!==targetWallet)continue;
      const mint=p.mint;
      if(mint===SOL)continue;

      // Check if this is a new acquisition (not in pre balances or increased)
      const preEntry=pre.find(pr=>pr.mint===mint&&keys.get(pr.accountIndex).toBase58()===targetWallet);
      const preAmount=preEntry?Number(preEntry.uiTokenAmount?.amount||0):0;
      const postAmount=Number(p.uiTokenAmount?.amount||0);

      if(postAmount>preAmount&&postAmount>0){
        return{mint,amount:postAmount-preAmount};
      }
    }
  }catch{}
  return null;
}

// WebSocket monitoring
const ws=new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${KEY}`);

ws.on("open",async()=>{
  const bal=await conn.getBalance(wallet.publicKey);
  console.log("=== COPY-TRADE BOT ===");
  console.log("Mode: "+(DRY_RUN?"DRY RUN":"LIVE"));
  console.log("Wallet: "+wallet.publicKey.toBase58());
  console.log("Balance: "+(bal/LAMPORTS_PER_SOL).toFixed(4)+" SOL");
  console.log("Buy amount: "+(BUY_AMOUNT/LAMPORTS_PER_SOL)+" SOL per trade");
  console.log("Targets: "+TARGETS.length+" wallets");
  console.log("Profit target: "+(PROFIT_TARGET*100-100)+"%");
  console.log("Stop loss: "+(100-STOP_LOSS*100)+"%\n");

  // Subscribe to target wallets
  for(const t of TARGETS){
    ws.send(JSON.stringify({
      jsonrpc:"2.0",id:1,
      method:"accountSubscribe",
      params:[t,{encoding:"base64",commitment:"confirmed"}]
    }));
  }
});

ws.on("message",async(data)=>{
  try{
    const m=JSON.parse(data);
    if(m.method!=="accountNotification")return;

    // A target wallet changed. Check their recent tx.
    for(const target of TARGETS){
      const sigs=await conn.getSignaturesForAddress(new PublicKey(target),{limit:1});
      if(!sigs.length)continue;

      const buyInfo=await parseTargetTx(sigs[0].signature,target);
      if(!buyInfo)continue;
      if(positions.has(buyInfo.mint))continue; // already in this token

      console.log("\n  >>> Target "+target.slice(0,8)+" bought "+buyInfo.mint.slice(0,12));

      // Copy the trade
      const result=await buyToken(buyInfo.mint,BUY_AMOUNT);
      if(result){
        positions.set(buyInfo.mint,{
          price:result.price,
          amount:result.tokenAmount,
          time:Date.now(),
          copiedFrom:target.slice(0,8)
        });
      }
    }
  }catch{}
});

// Check positions every 30 seconds
setInterval(checkPositions,30000);

// Status update every minute
setInterval(()=>{
  const el=((Date.now()-Date.now())/60000).toFixed(1); // will fix
  console.log("\r  trades="+trades+" wins="+wins+" pnl="+(totalPnL/1e9).toFixed(6)+" SOL positions="+positions.size+"   ");
},60000);

ws.on("error",()=>{});
ws.on("close",()=>{console.log("\nReconnecting...");process.exit(1);});
