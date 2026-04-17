#!/usr/bin/env node
/**
 * SIM-ARB: Real-time spread detection + atomic tx simulation
 * Measures ACTUAL profit (simulateTransaction), not just quote spread
 * $0 verification — no real execution
 */
const WebSocket=require("ws");
const{Connection,PublicKey,TransactionMessage,VersionedTransaction,TransactionInstruction,ComputeBudgetProgram,Keypair,SystemProgram}=require("@solana/web3.js");
const{TOKEN_PROGRAM_ID,getAssociatedTokenAddress,createSyncNativeInstruction,createAssociatedTokenAccountInstruction}=require("@solana/spl-token");
const fs=require("fs");

const KEY="YOUR_HELIUS_API_KEY";
const conn=new Connection(`https://mainnet.helius-rpc.com/?api-key=${KEY}`);
const WP=new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const SOL_MINT=new PublicKey("So11111111111111111111111111111111111111112");
const USDC=new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const walletData=JSON.parse(fs.readFileSync("./wallet.json"));
const wallet=Keypair.fromSecretKey(Buffer.from(walletData.secretKeyBase64,"base64"));

// Pool configs
const pools=[
  {name:"ts1",addr:new PublicKey("83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d"),ts:1,fee:0.0001},
  {name:"ts2",addr:new PublicKey("FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q"),ts:2,fee:0.0002},
  {name:"ts8",addr:new PublicKey("7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm"),ts:8,fee:0.0005},
];

const AMT=25000000; // 0.025 SOL — use most of balance but leave gas reserve
const GAS_COST=5200;
const file="results/sim-arb.jsonl";
fs.mkdirSync("results",{recursive:true});
let checks=0,sims=0,simOK=0,simProfit=0,totalProfit=0;
const startTime=Date.now();

function getTAPDA(pool,si){
  const[p]=PublicKey.findProgramAddressSync([Buffer.from("tick_array"),pool.toBuffer(),Buffer.from(si.toString())],WP);
  return p;
}

async function loadPoolData(){
  const infos=await conn.getMultipleAccountsInfo(pools.map(p=>p.addr));
  for(let i=0;i<pools.length;i++){
    const d=infos[i].data;
    pools[i].tick=d.readInt32LE(81);
    pools[i].vaultA=new PublicKey(d.slice(133,165));
    pools[i].vaultB=new PublicKey(d.slice(213,245));
    const sqrtLo=d.readBigUInt64LE(65);
    const sqrtHi=d.readBigUInt64LE(73);
    const sqrtPrice=(sqrtHi<<64n)|sqrtLo;
    const p=Number(sqrtPrice)/2**64;
    pools[i].price=p*p*1000;
    const[oracle]=PublicKey.findProgramAddressSync([Buffer.from("oracle"),pools[i].addr.toBuffer()],WP);
    pools[i].oracle=oracle;
  }
}

async function tryArbSim(buyPool,sellPool){
  // buyPool: SOL→USDC (aToB=true)
  // sellPool: USDC→SOL (aToB=false)
  const spread=(sellPool.price-buyPool.price)/buyPool.price;
  const fee=buyPool.fee+sellPool.fee;
  const netSpread=spread-fee;

  if(netSpread*AMT<=GAS_COST)return; // not worth simulating

  sims++;

  const wsolAta=await getAssociatedTokenAddress(SOL_MINT,wallet.publicKey);
  const usdcAta=await getAssociatedTokenAddress(USDC,wallet.publicKey);

  const tpaB=88*buyPool.ts;
  const startB=Math.floor(buyPool.tick/tpaB)*tpaB;
  const tpaS=88*sellPool.ts;
  const startS=Math.floor(sellPool.tick/tpaS)*tpaS;

  const ixs=[];
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({units:400000}));
  ixs.push(ComputeBudgetProgram.setComputeUnitPrice({microLamports:100}));

  // Check if WSOL ATA exists
  const wsolInfo=await conn.getAccountInfo(wsolAta);
  if(!wsolInfo){
    ixs.push(createAssociatedTokenAccountInstruction(wallet.publicKey,wsolAta,wallet.publicKey,SOL_MINT));
  }

  ixs.push(SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:wsolAta,lamports:AMT}));
  ixs.push(createSyncNativeInstruction(wsolAta));

  // LEG 1: SOL→USDC (aToB=true) on buyPool (lower price)
  const s1=Buffer.alloc(42);
  Buffer.from("f8c69e91e17587c8","hex").copy(s1,0);
  s1.writeBigUInt64LE(BigInt(AMT),8);
  s1.writeBigUInt64LE(1n,16);
  s1.writeBigUInt64LE(4295048017n,24);s1.writeBigUInt64LE(0n,32); // MIN_SQRT
  s1[40]=1;s1[41]=1; // aToB=true

  ixs.push(new TransactionInstruction({programId:WP,keys:[
    {pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:wallet.publicKey,isSigner:true,isWritable:false},
    {pubkey:buyPool.addr,isSigner:false,isWritable:true},
    {pubkey:wsolAta,isSigner:false,isWritable:true},
    {pubkey:buyPool.vaultA,isSigner:false,isWritable:true},
    {pubkey:usdcAta,isSigner:false,isWritable:true},
    {pubkey:buyPool.vaultB,isSigner:false,isWritable:true},
    {pubkey:getTAPDA(buyPool.addr,startB),isSigner:false,isWritable:true},
    {pubkey:getTAPDA(buyPool.addr,startB-tpaB),isSigner:false,isWritable:true},
    {pubkey:getTAPDA(buyPool.addr,startB-2*tpaB),isSigner:false,isWritable:true},
    {pubkey:buyPool.oracle,isSigner:false,isWritable:false},
  ],data:s1}));

  // SIM leg1 alone first to get exact USDC output
  let usdcFromLeg1;
  try{
    const{blockhash:bh1}=await conn.getLatestBlockhash();
    const msg1=new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:bh1,instructions:ixs}).compileToV0Message();
    const tx1=new VersionedTransaction(msg1);
    const sim1=await conn.simulateTransaction(tx1,{sigVerify:false,replaceRecentBlockhash:true,
      accounts:{encoding:"base64",addresses:[usdcAta.toBase58()]}});
    if(sim1.value.err||!sim1.value.accounts||!sim1.value.accounts[0])return;
    const uData=Buffer.from(sim1.value.accounts[0].data[0],"base64");
    usdcFromLeg1=Number(uData.readBigUInt64LE(64));
    if(usdcFromLeg1<=0)return;
  }catch{return;}

  // LEG 2: USDC→SOL (aToB=false) on sellPool (higher price)
  const s2=Buffer.alloc(42);
  Buffer.from("f8c69e91e17587c8","hex").copy(s2,0);
  s2.writeBigUInt64LE(BigInt(usdcFromLeg1),8); // exact USDC from leg1
  s2.writeBigUInt64LE(1n,16);
  const MAX=79226673515401279992447579055n;
  s2.writeBigUInt64LE(MAX&((1n<<64n)-1n),24);s2.writeBigUInt64LE(MAX>>64n,32);
  s2[40]=1;s2[41]=0; // aToB=false

  ixs.push(new TransactionInstruction({programId:WP,keys:[
    {pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:wallet.publicKey,isSigner:true,isWritable:false},
    {pubkey:sellPool.addr,isSigner:false,isWritable:true},
    {pubkey:wsolAta,isSigner:false,isWritable:true},
    {pubkey:sellPool.vaultA,isSigner:false,isWritable:true},
    {pubkey:usdcAta,isSigner:false,isWritable:true},
    {pubkey:sellPool.vaultB,isSigner:false,isWritable:true},
    {pubkey:getTAPDA(sellPool.addr,startS),isSigner:false,isWritable:true},
    {pubkey:getTAPDA(sellPool.addr,startS+tpaS),isSigner:false,isWritable:true},
    {pubkey:getTAPDA(sellPool.addr,startS+2*tpaS),isSigner:false,isWritable:true},
    {pubkey:sellPool.oracle,isSigner:false,isWritable:false},
  ],data:s2}));

  try{
    const{blockhash}=await conn.getLatestBlockhash();
    const msg=new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:blockhash,instructions:ixs}).compileToV0Message();
    const tx=new VersionedTransaction(msg);

    const sim=await conn.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true,
      accounts:{encoding:"base64",addresses:[wsolAta.toBase58()]}});

    if(!sim.value.err&&sim.value.accounts&&sim.value.accounts[0]){
      const wsolData=Buffer.from(sim.value.accounts[0].data[0],"base64");
      const solOut=Number(wsolData.readBigUInt64LE(64));
      const profit=solOut-AMT;
      const netProfit=profit-GAS_COST;

      simOK++;
      if(netProfit>0){
        simProfit++;
        totalProfit+=netProfit;
        const msg=`*** SIM PROFIT: ${buyPool.name}→${sellPool.name} in=${AMT} out=${solOut} profit=${profit} net=${netProfit} spread=${(netSpread*100).toFixed(4)}%`;
        console.log("\n  "+msg);
        fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),
          buy:buyPool.name,sell:sellPool.name,amt:AMT,out:solOut,profit,net:netProfit,
          spread:(netSpread*100).toFixed(4),cu:sim.value.unitsConsumed,action:"SIM_PROFIT"})+"\n");
      }else{
        fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),
          buy:buyPool.name,sell:sellPool.name,profit,net:netProfit,action:"SIM_LOSS"})+"\n");
      }
    }else if(sim.value.err){
      fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),
        buy:buyPool.name,sell:sellPool.name,action:"SIM_FAIL",err:JSON.stringify(sim.value.err).slice(0,50)})+"\n");
    }
  }catch(e){
    fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),action:"ERROR",err:e.message?.slice(0,50)})+"\n");
  }
}

async function onPoolChange(){
  await loadPoolData();
  checks++;

  // Check all pool pairs
  for(let i=0;i<pools.length;i++){
    for(let j=0;j<pools.length;j++){
      if(i===j)continue;
      // Buy USDC on pool with lower price (SOL→USDC = aToB=true)
      // Sell USDC on pool with higher price (USDC→SOL = aToB=false)
      if(pools[j].price>pools[i].price){
        await tryArbSim(pools[i],pools[j]);
      }
    }
  }

  const el=((Date.now()-startTime)/60000).toFixed(1);
  process.stdout.write(`\r  [${el}m] checks=${checks} sims=${sims} simOK=${simOK} simProfit=${simProfit} total=${(totalProfit/1e9).toFixed(6)} SOL   `);
}

// Main
(async()=>{
  await loadPoolData();
  const bal=await conn.getBalance(wallet.publicKey);
  console.log("=== SIM-ARB BOT ===");
  console.log("Balance: "+(bal/1e9).toFixed(4)+" SOL");
  console.log("Trade size: "+(AMT/1e9)+" SOL");
  console.log("Pools: "+pools.map(p=>p.name+"("+p.fee*100+"%)").join(", "));
  console.log("Looking for profitable atomic swaps via simulateTransaction\n");

  const ws=new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${KEY}`);
  ws.on("open",()=>{
    for(const p of pools)ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"accountSubscribe",
      params:[p.addr.toBase58(),{encoding:"base64",commitment:"confirmed"}]}));
    onPoolChange();
  });
  ws.on("message",async()=>{await onPoolChange();});
  ws.on("error",()=>{});
  ws.on("close",()=>{console.log("\nWS closed");process.exit(0);});

  setTimeout(()=>{
    console.log("\n\n=== 15 MIN SUMMARY ===");
    console.log("Checks: "+checks+" Sims: "+sims+" SimOK: "+simOK+" SimProfit: "+simProfit);
    console.log("Total profit (sim): "+(totalProfit/1e9).toFixed(6)+" SOL = $"+((totalProfit/1e9)*89).toFixed(4));
    process.exit(0);
  },15*60*1000);
})();
