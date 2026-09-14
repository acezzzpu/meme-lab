import {readFileSync,writeFileSync} from 'node:fs';
const fixtures=JSON.parse(readFileSync('tests/fixtures/v4/five-routing-failures.json')).fixtures;
let id=0;async function rpc(method,params){const r=await fetch(process.env.V4_FIXTURE_RPC??'https://bsc-rpc.publicnode.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(10000)});const j=await r.json();if(j.error)throw Error(JSON.stringify(j.error));return j.result;}
for(const f of fixtures){try{const [tx,receipt,block]=await Promise.all([rpc('eth_getTransactionByHash',[f.target_tx]),rpc('eth_getTransactionReceipt',[f.target_tx]),rpc('eth_getBlockByNumber',['0x'+f.block.toString(16),false])]);if(!tx||!receipt||!block)throw Error('MISSING_CHAIN_EVIDENCE');writeFileSync('tests/fixtures/v4/'+f.id+'.json',JSON.stringify({tx,receipt,block}),{flag:'wx'});console.log(f.id,'CAPTURED');}catch(e){console.log(f.id,e.message);process.exitCode=1;}}

