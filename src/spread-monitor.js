// $0 monitoring: pool間価格差の動的監視
// Orca Whirlpool SOL/USDC pools: ts=1(0.01%), ts=2(0.02%), ts=4(0.04%), ts=8(0.05%), ts=64(0.30%)
const{Connection,PublicKey}=require("@solana/web3.js");
const fs=require("fs");
const conn=new Connection("https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY");
const WP=new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

const pools=[
  {name:"ts1",addr:new PublicKey("83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d"),ts:1,fee:0.0001},
  {name:"ts2",addr:new PublicKey("FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q"),ts:2,fee:0.0002},
  {name:"ts4",addr:new PublicKey("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"),ts:4,fee:0.0004},
  {name:"ts8",addr:new PublicKey("7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm"),ts:8,fee:0.0005},
  {name:"ts64",addr:new PublicKey("HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"),ts:64,fee:0.003},
];

const file="results/spread-monitor.jsonl";
fs.mkdirSync("results",{recursive:true});
let checks=0,profitable=0;
const startTime=Date.now();

async function readPrices(){
  const infos=await conn.getMultipleAccountsInfo(pools.map(p=>p.addr));
  const prices=[];
  for(let i=0;i<pools.length;i++){
    if(!infos[i])continue;
    const d=infos[i].data;
    const sqrtLo=d.readBigUInt64LE(65);
    const sqrtHi=d.readBigUInt64LE(73);
    const sqrtPrice=(sqrtHi<<64n)|sqrtLo;
    // price = (sqrtPrice/2^64)^2, adjusted for decimals (SOL 9dec, USDC 6dec)
    // price_usdc_per_sol = (sqrtPrice/2^64)^2 * 10^(9-6) = (sqrtPrice/2^64)^2 * 1000
    const p=Number(sqrtPrice)/2**64;
    const price=p*p*1000; // USDC per SOL
    prices.push({...pools[i],price,sqrtPrice});
  }
  return prices;
}

async function checkSpreads(){
  try{
    const prices=await readPrices();
    checks++;
    const ts=new Date().toISOString();
    
    // Check all pairs for arb opportunity
    let bestProfit=-Infinity,bestPair=null;
    for(let i=0;i<prices.length;i++){
      for(let j=0;j<prices.length;j++){
        if(i===j)continue;
        // Buy SOL on pool i (lower price), sell on pool j (higher price)
        // Spread = (priceJ - priceI) / priceI
        const spread=(prices[j].price-prices[i].price)/prices[i].price;
        const roundTripFee=prices[i].fee+prices[j].fee;
        const netProfit=spread-roundTripFee;
        if(netProfit>bestProfit){
          bestProfit=netProfit;
          bestPair={buy:prices[i].name,sell:prices[j].name,spread,fee:roundTripFee,net:netProfit};
        }
      }
    }
    
    const entry={ts,prices:prices.map(p=>({n:p.name,p:p.price.toFixed(4)})),best:bestPair};
    
    if(bestPair&&bestPair.net>0){
      profitable++;
      console.log("\n  *** PROFITABLE: "+bestPair.buy+"→"+bestPair.sell+" spread="+
        (bestPair.spread*100).toFixed(4)+"% fee="+(bestPair.fee*100).toFixed(4)+
        "% net="+(bestPair.net*100).toFixed(4)+"%");
      fs.appendFileSync(file,JSON.stringify({...entry,profitable:true})+"\n");
    }else{
      fs.appendFileSync(file,JSON.stringify(entry)+"\n");
    }
    
    const el=((Date.now()-startTime)/60000).toFixed(1);
    process.stdout.write("\r  ["+el+"m] checks="+checks+" profitable="+profitable+
      " best="+(bestPair?(bestPair.net*100).toFixed(4)+"%":"?")+
      " prices="+prices.map(p=>p.price.toFixed(2)).join("/")+"   ");
      
  }catch(e){
    // silent retry
  }
}

// WebSocket for real-time pool changes
const WebSocket=require("ws");
const ws=new WebSocket("wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY");
ws.on("open",()=>{
  console.log("=== SPREAD MONITOR STARTED ===");
  console.log("Pools: "+pools.map(p=>p.name+"("+p.fee*100+"%)").join(", "));
  console.log("Profitable = spread > roundTrip fee");
  console.log("Best case fee: ts1+ts2 = 0.03%\n");
  
  for(const p of pools){
    ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"accountSubscribe",
      params:[p.addr.toBase58(),{encoding:"base64",commitment:"confirmed"}]}));
  }
  checkSpreads(); // initial check
});

ws.on("message",async()=>{
  await checkSpreads();
});

ws.on("error",()=>{});
ws.on("close",()=>{console.log("\nWS closed");process.exit(0);});

// Also poll every 2s as backup
setInterval(checkSpreads,2000);

// Auto-stop after 30 minutes
setTimeout(()=>{
  console.log("\n\n=== 30 MIN SUMMARY ===");
  console.log("Total checks: "+checks);
  console.log("Profitable moments: "+profitable);
  console.log("Rate: "+(profitable/checks*100).toFixed(2)+"%");
  process.exit(0);
},30*60*1000);
