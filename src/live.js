#!/usr/bin/env node
/**
 * LIVE ARB BOT — real execution
 * Same logic as hybrid-final test (which confirmed $0.0015/15min profit)
 * but actually signs and sends transactions.
 */
require("dotenv").config();
const WebSocket=require("ws");
const{Connection,PublicKey,TransactionMessage,VersionedTransaction,TransactionInstruction,ComputeBudgetProgram,Keypair,LAMPORTS_PER_SOL}=require("@solana/web3.js");
const fs=require("fs");

const KEY="YOUR_HELIUS_API_KEY";
const conn=new Connection(`https://mainnet.helius-rpc.com/?api-key=${KEY}`);
const J="https://lite-api.jup.ag/swap/v1";
const SOL="So11111111111111111111111111111111111111112";
const JUP_T="JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

// Load wallet
const walletData=JSON.parse(fs.readFileSync("./wallet.json"));
const secretKey=Buffer.from(walletData.secretKeyBase64,"base64");
const wallet=Keypair.fromSecretKey(secretKey);
console.log("Wallet:",wallet.publicKey.toBase58());

const BASE_FEE=5200;
const MIN_BALANCE=5000000; // 0.005 SOL minimum to keep

function toIx(r){return new TransactionInstruction({programId:new PublicKey(r.programId),keys:r.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable})),data:Buffer.from(r.data,"base64")});}

async function sf(u,o){for(let i=0;i<2;i++){try{const r=await fetch(u,o);if(r.ok)return await r.json();if(r.status===429){await new Promise(r=>setTimeout(r,1500));continue;}}catch{}}return null;}

const targets=[
  {sym:"JUP_HALF",mint:JUP_T,size:5000000},
];
const pools=["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2","HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"];

fs.mkdirSync("results",{recursive:true});
const file="results/live.jsonl";
let swaps=0,checks=0,executed=0,totalProfit=0;
const startTime=Date.now();

async function tryArb(t){
  const q1=await sf(J+"/quote?inputMint="+SOL+"&outputMint="+t.mint+"&amount="+t.size+"&slippageBps=300");
  if(!q1||!q1.outAmount)return;
  const q2=await sf(J+"/quote?inputMint="+t.mint+"&outputMint="+SOL+"&amount="+q1.outAmount+"&slippageBps=300");
  if(!q2||!q2.outAmount)return;
  checks++;
  const profit=Number(q2.outAmount)-t.size;
  if(profit<=BASE_FEE)return;

  // Build atomic tx
  const si1=await sf(J+"/swap-instructions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({quoteResponse:q1,userPublicKey:wallet.publicKey.toBase58(),wrapAndUnwrapSol:true})});
  if(!si1||si1.error)return;
  const si2=await sf(J+"/swap-instructions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({quoteResponse:q2,userPublicKey:wallet.publicKey.toBase58(),wrapAndUnwrapSol:true})});
  if(!si2||si2.error)return;

  const ixs=[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:100})];
  const seen=new Set();
  for(const ix of(si1.setupInstructions||[])){const k=ix.programId+ix.accounts.map(a=>a.pubkey).join("");if(!seen.has(k)){seen.add(k);ixs.push(toIx(ix));}}
  ixs.push(toIx(si1.swapInstruction));
  for(const ix of(si2.setupInstructions||[])){const k=ix.programId+ix.accounts.map(a=>a.pubkey).join("");if(!seen.has(k)){ixs.push(toIx(ix));}}
  ixs.push(toIx(si2.swapInstruction));
  // Skip cleanup to keep ATAs persistent (avoid re-creation cost)
  // if(si2.cleanupInstruction)ixs.push(toIx(si2.cleanupInstruction));

  const altA=[...new Set([...(si1.addressLookupTableAddresses||[]),...(si2.addressLookupTableAddresses||[])])];
  const alts=[];for(const a of altA){try{const r=await conn.getAddressLookupTable(new PublicKey(a));if(r.value)alts.push(r.value);}catch{}}

  try{
    const{blockhash,lastValidBlockHeight}=await conn.getLatestBlockhash();
    const msg=new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:blockhash,instructions:ixs}).compileToV0Message(alts);
    const tx=new VersionedTransaction(msg);

    // Simulate first
    const sim=await conn.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true});
    if(sim.value.err){
      fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),sym:t.sym,profit,action:"sim_fail",err:JSON.stringify(sim.value.err).slice(0,50)})+"\n");
      return;
    }

    // Sign and send
    tx.sign([wallet]);
    const sig=await conn.sendTransaction(tx,{skipPreflight:true,maxRetries:2});

    // Confirm
    const confirm=await conn.confirmTransaction({signature:sig,blockhash,lastValidBlockHeight},"confirmed");

    if(!confirm.value.err){
      executed++;
      const net=profit-BASE_FEE;
      totalProfit+=net;
      const msg=`✓✓ EXECUTED! ${t.sym} profit=${profit} net=${net} sig=${sig.slice(0,20)}...`;
      console.log("\n  "+msg);
      fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),sym:t.sym,profit,net,action:"executed",sig})+"\n");
    }else{
      fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),sym:t.sym,profit,action:"tx_fail",sig})+"\n");
    }
  }catch(e){
    fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),sym:t.sym,profit,action:"error",err:e.message?.slice(0,50)})+"\n");
  }
}

// Safety check
async function checkBalance(){
  const bal=await conn.getBalance(wallet.publicKey);
  if(bal<MIN_BALANCE){console.log("\n⚠ Balance too low: "+(bal/LAMPORTS_PER_SOL)+" SOL. Stopping.");process.exit(0);}
  return bal;
}

const ws=new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${KEY}`);
ws.on("open",async()=>{
  const bal=await checkBalance();
  console.log("=== LIVE ARB BOT STARTED ===");
  console.log("Balance: "+(bal/LAMPORTS_PER_SOL)+" SOL");
  console.log("Min balance: "+(MIN_BALANCE/LAMPORTS_PER_SOL)+" SOL");
  console.log("Targets: "+targets.map(t=>t.sym).join(", "));
  console.log("");
  for(const p of pools)ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"accountSubscribe",params:[p,{encoding:"base64",commitment:"confirmed"}]}));
});

ws.on("message",async(data)=>{
  try{
    const m=JSON.parse(data);if(m.method!=="accountNotification")return;
    swaps++;
    for(const t of targets)await tryArb(t);
    if(swaps%20===0)await checkBalance();
    const el=((Date.now()-startTime)/60000).toFixed(1);
    process.stdout.write("\r  ["+el+"m] swaps="+swaps+" checks="+checks+" executed="+executed+" profit="+(totalProfit/1e9*89).toFixed(6)+"   ");
  }catch{}
});

ws.on("error",()=>{});
ws.on("close",()=>{console.log("\nWS closed. Reconnecting...");setTimeout(()=>{process.exit(1);},2000);});
