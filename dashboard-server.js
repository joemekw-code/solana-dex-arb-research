const http=require("http");
const fs=require("fs");
const path=require("path");
require("dotenv").config();
const{Connection,PublicKey}=require("@solana/web3.js");
const conn=new Connection(process.env.RPC_URL);
const WALLET="YOUR_WALLET_ADDRESS";
const startTime=Date.now();

http.createServer(async(req,res)=>{
  if(req.url==="/api/status"){
    try{
      const bal=await conn.getBalance(new PublicKey(WALLET));
      const logFile="results/live.log";
      const log=fs.existsSync(logFile)?fs.readFileSync(logFile,"utf8"):"";
      const lastLine=[...log.matchAll(/swaps=(\d+) checks=(\d+) executed=(\d+) profit=([\d.-]+)/g)].pop();
      const jsonlFile="results/live.jsonl";
      const events=fs.existsSync(jsonlFile)?fs.readFileSync(jsonlFile,"utf8").trim().split("\n").filter(l=>l).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(l=>l).reverse().slice(0,50):[];
      const mins=((Date.now()-startTime)/60000).toFixed(0);
      res.writeHead(200,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
      res.end(JSON.stringify({
        balance:(bal/1e9).toFixed(4),
        swaps:lastLine?lastLine[1]:"0",
        checks:lastLine?lastLine[2]:"0",
        executed:lastLine?lastLine[3]:"0",
        totalProfitUsd:lastLine?parseFloat(lastLine[4]).toFixed(6):"0",
        uptime:mins+"m",
        events,
      }));
    }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
  }else{
    const html=fs.readFileSync(path.join(__dirname,"dashboard.html"));
    res.writeHead(200,{"Content-Type":"text/html"});
    res.end(html);
  }
}).listen(3456,()=>console.log("Dashboard: http://localhost:3456"));
