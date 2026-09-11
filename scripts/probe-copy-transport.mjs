import https from 'node:https';
import {resolve} from 'node:path';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {Store} from '../core/store.mjs';
// Explicit four-read transport experiment. These isolated socket timings do not
// pretend to be per-request DNS/TLS timing of the worker's pooled fetch client.
const results=[];
for(const host of ['bsc-rpc.publicnode.com','bsc-dataseed.bnbchain.org']){
 const agent=new https.Agent({keepAlive:true,maxSockets:1});
 for(const temperature of ['COLD_SOCKET','REUSED_SOCKET']){
  const start=performance.now(),marks={},body=JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]});
  const row=await new Promise(resolve=>{const req=https.request({hostname:host,path:'/',method:'POST',agent,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{marks.first_byte=performance.now()-start;let data='';res.on('data',c=>data+=c);res.on('end',()=>{let parsed;try{parsed=JSON.parse(data);}catch{}resolve({host,temperature,reused_socket:req.reusedSocket,dns_ms:marks.lookup??null,tcp_ms:marks.connect!==undefined?marks.connect-(marks.lookup??0):null,tls_ms:marks.tls!==undefined?marks.tls-(marks.connect??0):null,time_to_first_byte_ms:marks.first_byte,response_body_ms:performance.now()-start-marks.first_byte,total_ms:performance.now()-start,status:res.statusCode,rpc_error:parsed?.error??null,block:parsed?.result??null});});});req.on('socket',s=>{s.once('lookup',()=>marks.lookup=performance.now()-start);s.once('connect',()=>marks.connect=performance.now()-start);s.once('secureConnect',()=>marks.tls=performance.now()-start);});req.on('error',e=>resolve({host,temperature,error:e.message}));req.setTimeout(4000,()=>req.destroy(Error('TRANSPORT_TIMEOUT')));req.end(body);});results.push(row);
 }agent.destroy();
}
const db=sqliteDriver(resolve(process.env.DATA_DIR??'data','meme-lab.sqlite')),store=new Store(db),result={at:Date.now(),source:'ACTUAL_RENDER_ISOLATED_HTTPS_SOCKET_PROBE',not_production_fetch_request_attribution:true,reads:4,results};await store.set('copy_transport_probe',result);console.log(JSON.stringify(result));db.close();
