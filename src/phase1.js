// Phase 1: 複利bot — 利益が出たら残高に加算、サイズを動的に最大化
require("dotenv").config();
const WebSocket=require("ws");
const{Connection,PublicKey,TransactionMessage,VersionedTransaction,TransactionInstruction,ComputeBudgetProgram,Keypair,LAMPORTS_PER_SOL}=require("@solana/web3.js");
const fs=require("fs");
const conn=new Connection(process.env.RPC_URL);
const walletData=JSON.parse(fs.readFileSync("./wallet.json"));
const wallet=Keypair.fromSecretKey(Buffer.from(walletData.secretKeyBase64,"base64"));
const KEY="YOUR_HELIUS_API_KEY";
const SOL="So11111111111111111111111111111111111111112";
const JUP="JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const J="https://lite-api.jup.ag/swap/v1";
const DRY_RUN=process.argv.includes("--dry-run");
const RESERVE=5000000; // 0.005 SOL reserved for gas
const MIN_GAS=5040;

function toIx(r){return new TransactionInstruction({programId:new PublicKey(r.programId),keys:r.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable})),data:Buffer.from(r.data,"base64")});}
async function sf(u,o){for(let i=0;i<2;i++){try{const r=await fetch(u,o);if(r.ok)return await r.json();await new Promise(r=>setTimeout(r,1500));}catch{}}return null;}

fs.mkdirSync("results",{recursive:true});
const file="results/phase1.jsonl";
let swaps=0,checks=0,executed=0,simOK=0,totalNet=0;
const startTime=Date.now();

async function tryArb(){
  // Dynamic size: use all available balance minus reserve
  const bal=await conn.getBalance(wallet.publicKey);
  const tradeSize=Math.min(bal-RESERVE,30000000); // max 0.03 SOL
  if(tradeSize<1000000)return; // min 0.001 SOL

  const q1=await sf(J+"/quote?inputMint="+SOL+"&outputMint="+JUP+"&amount="+tradeSize+"&slippageBps=300");
  if(!q1?.outAmount)return;
  const q2=await sf(J+"/quote?inputMint="+JUP+"&outputMint="+SOL+"&amount="+q1.outAmount+"&slippageBps=300");
  if(!q2?.outAmount)return;
  checks++;
  const profit=Number(q2.outAmount)-tradeSize;
  if(profit<=MIN_GAS)return;

  // Build atomic tx (no cleanup)
  const si1=await sf(J+"/swap-instructions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({quoteResponse:q1,userPublicKey:wallet.publicKey.toBase58(),wrapAndUnwrapSol:true})});
  const si2=await sf(J+"/swap-instructions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({quoteResponse:q2,userPublicKey:wallet.publicKey.toBase58(),wrapAndUnwrapSol:true})});
  if(!si1||si1.error||!si2||si2.error)return;

  const ixs=[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:100})];
  const seen=new Set();
  for(const ix of(si1.setupInstructions||[])){const k=ix.programId+ix.accounts.map(a=>a.pubkey).join("");if(!seen.has(k)){seen.add(k);ixs.push(toIx(ix));}}
  ixs.push(toIx(si1.swapInstruction));
  for(const ix of(si2.setupInstructions||[])){const k=ix.programId+ix.accounts.map(a=>a.pubkey).join("");if(!seen.has(k)){ixs.push(toIx(ix));}}
  ixs.push(toIx(si2.swapInstruction));
  // NO cleanup — keep ATAs

  const altA=[...new Set([...(si1.addressLookupTableAddresses||[]),...(si2.addressLookupTableAddresses||[])])];
  const alts=[];for(const a of altA){try{const r=await conn.getAddressLookupTable(new PublicKey(a));if(r.value)alts.push(r.value);}catch{}}

  try{
    const{blockhash,lastValidBlockHeight}=await conn.getLatestBlockhash();
    const msg=new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:blockhash,instructions:ixs}).compileToV0Message(alts);
    const tx=new VersionedTransaction(msg);

    // Always simulate first
    const sim=await conn.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true});
    if(sim.value.err){
      fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),size:tradeSize,profit,action:"sim_fail"})+"\n");
      return;
    }

    const gas=5000+Math.ceil((sim.value.unitsConsumed||400000)*100/1e6);
    const net=profit-gas;
    if(net<=0){
      fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),size:tradeSize,profit,gas,net,action:"gas_fail"})+"\n");
      return;
    }

    simOK++;

    if(DRY_RUN){
      totalNet+=net;
      console.log("\n  ✓ [DRY] size="+(tradeSize/1e9).toFixed(4)+" profit="+profit+" gas="+gas+" net="+net+" ($"+(net/1e9*89).toFixed(6)+")");
      fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),size:tradeSize,profit,gas,net,action:"dry_ok"})+"\n");
      return;
    }

    // LIVE: sign and send
    tx.sign([wallet]);
    const sig=await conn.sendTransaction(tx,{skipPreflight:true,maxRetries:2});
    const confirm=await conn.confirmTransaction({signature:sig,blockhash,lastValidBlockHeight},"confirmed");

    if(!confirm.value.err){
      executed++;
      totalNet+=net;
      const newBal=await conn.getBalance(wallet.publicKey);
      console.log("\n  ✓ EXECUTED! net="+net+" bal="+(newBal/1e9).toFixed(4)+" sig="+sig.slice(0,16));
      fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),size:tradeSize,profit,gas,net,action:"executed",sig,bal:newBal})+"\n");
    }else{
      fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),size:tradeSize,profit,action:"tx_fail",sig})+"\n");
    }
  }catch(e){
    fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),size:tradeSize,profit,action:"error",err:e.message?.slice(0,40)})+"\n");
  }
}

const ws=new WebSocket("wss://mainnet.helius-rpc.com/?api-key="+KEY);
ws.on("open",async()=>{
  const bal=await conn.getBalance(wallet.publicKey);
  console.log("=== PHASE 1 "+(DRY_RUN?"[DRY RUN]":"[LIVE]")+" ===");
  console.log("Balance: "+(bal/LAMPORTS_PER_SOL)+" SOL ($"+(bal/LAMPORTS_PER_SOL*89).toFixed(2)+")");
  console.log("Trade size: dynamic (balance - 0.005 SOL reserve)");
  console.log("");
  ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2","HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"].forEach(p=>
    ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"accountSubscribe",params:[p,{encoding:"base64",commitment:"confirmed"}]}))
  );
});
ws.on("message",async(data)=>{
  try{
    const m=JSON.parse(data);if(m.method!=="accountNotification")return;
    swaps++;
    await tryArb();
    const el=((Date.now()-startTime)/60000).toFixed(1);
    process.stdout.write("\r  ["+el+"m] swaps="+swaps+" checks="+checks+" sim="+simOK+" exec="+executed+" net=$"+(totalNet/1e9*89).toFixed(6)+"   ");
  }catch{}
});
ws.on("error",()=>{});
ws.on("close",()=>{setTimeout(()=>process.exit(1),2000);});
