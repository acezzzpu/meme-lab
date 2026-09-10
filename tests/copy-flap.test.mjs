import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FLAP,FLAP_PORTAL,FlapRoute,ZERO,recoverFlapObservations} from '../runtime/copy/flap.mjs';
import {decodeTarget} from '../runtime/copy/decoder.mjs';
import {RouteEngine} from '../runtime/copy/routes.mjs';
import {BSC,hex,encode} from '../core/copy/common.mjs';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';

const recorded=JSON.parse(await readFile(new URL('../docs/evidence/bnb-target/flap-transactions.json',import.meta.url),'utf8'));
const block=f=>({timestamp:hex(Math.floor(f.target_at/1000))});
const replay=f=>({contract:async(a,abi,method)=>{
 if(method==='symbol')return [f.symbol];if(method==='decimals')return [BigInt(f.decimals)];
 throw Error('UNAVAILABLE_CONTRACT_'+method);
},call:async()=>{throw Error('RPC_-32000: missing trie node');}});

test('real AstroX BUY is attributed to the target via Flap, keeping native input as an estimate',async()=>{
 const f=recorded[0],d=await decodeTarget(replay(f),f.tx,f.receipt,block(f),f.target);
 assert.equal(d.protocol,'FLAP');assert.equal(d.kind,'BUY');
 assert.equal(d.quantity_raw,'301591254347276135888181');
 assert.equal(d.quote_raw,'10000000000000000');assert.ok(d.quote_estimate);
 assert.equal(d.native_balance_evidence,false);
 assert.notEqual(d.quote_raw,d.protocol_evidence.event_quote_raw,'The intermediate quote is not BNB');
});
test('two real Flap sales stay visible without inventing the final BNB proceeds',async()=>{
 for(const f of recorded.slice(1)){
  const d=await decodeTarget(replay(f),f.tx,f.receipt,block(f),f.target);
  assert.equal(d.kind,'OBSERVED_SELL');assert.equal(d.protocol,'FLAP');
  assert.equal(d.side,null,'Missing native proceeds must not create a copy action');
  assert.equal(d.quote_raw,undefined);assert.equal(d.reason,'QUOTE_AMOUNT_NOT_VERIFIABLE');
  assert.equal(d.protocol_evidence.event_quote_currency,'UNRESOLVED_NOT_ASSUMED_BNB');
  assert.match(d.quote_evidence_error,/missing trie node/);
 }
});
test('a forged Portal emitter, mismatched transfer or duplicate trade cannot establish attribution',async()=>{
 for(const alteration of ['emitter','transfer','duplicate']){
  const f=structuredClone(recorded[2]);const log=f.receipt.logs.find(l=>l.address.toLowerCase()===FLAP_PORTAL&&l.topics[0]===FLAP.getEvent('TokenSold').topicHash);
  if(alteration==='emitter')log.address='0x1111111111111111111111111111111111111111';
  if(alteration==='duplicate')f.receipt.logs.push({...log});
  if(alteration==='transfer')f.receipt.logs=f.receipt.logs.filter(l=>!(l.address.toLowerCase()===f.token&&l.topics[1]?.endsWith(f.target.slice(2))));
  const d=await decodeTarget(replay(f),f.tx,f.receipt,block(f),f.target);
  assert.notEqual(d.protocol,'FLAP');assert.equal(d.side,null);
 }
});
test('complete tx-specific trace unlocks exact Flap SELL attribution, without inventing historical balance',async()=>{
 const f=recorded[2],rpc=replay(f);rpc.call=async(method)=>{assert.equal(method,'debug_traceTransaction');return {type:'CALL',from:f.target,to:f.tx.to,value:'0x0',calls:[{type:'CALL',from:f.tx.to,to:f.target,value:hex(7000000000000000n)}]};};
 const d=await decodeTarget(rpc,f.tx,f.receipt,block(f),f.target);
 assert.equal(d.kind,'SELL');assert.equal(d.native_balance_evidence,true);
 assert.equal(d.quote_raw,'7000000000000000');assert.equal(d.sold_fraction,null);
 assert.equal(d.exit_evidence,'HISTORICAL_BALANCE_UNAVAILABLE');
});

function quotedRPC({status=1,quoteToken=ZERO,nativeEnabled=true}={}){
 const calls=[];const rpc={verify:async()=>{},call:async method=>method==='eth_blockNumber'?'0x10':'0x1',contract:async(address,abi,method,args=[],tag='latest')=>{
  calls.push({address,method,args,tag});
  if(method==='getTokenV8Safe')return [{status,reserve:10n**18n,quoteTokenAddress:quoteToken,nativeToQuoteSwapEnabled:nativeEnabled,buyTaxRate:0n,sellTaxRate:0n}];
  if(method==='quoteExactInput')return [BigInt(args[0][2])*2n];
  if(method==='allowance')return [0n];
  throw Error('UNEXPECTED_'+method);
 }};return {rpc,calls};
}
const request={side:'BUY',token:recorded[2].token,amount:'1000000000000000',slippageBps:100,taker:recorded[2].target};
test('Flap quote/build use native zero address, same block, bounded min output and the dedicated Portal',async()=>{
 const {rpc,calls}=quotedRPC(),route=new FlapRoute(rpc),q=await route.quote(request);
 assert.equal(q.out_raw,'2000000000000000');assert.equal(q.min_out_raw,'1980000000000000');
 assert.equal(q.route[0],ZERO);assert.equal(q.live_supported,false);assert.equal(q.impact_pct,0);
 assert.ok(calls.filter(c=>c.method==='quoteExactInput').every(c=>c.tag==='0x10'));
 const b=await route.build(q,request.taker,{max_quote_age_ms:5000});
 const [params]=FLAP.decodeFunctionData('swapExactInput',b.tx.data);
 assert.equal(params.inputToken,ZERO);assert.equal(params.minOutputAmount,1980000000000000n);
 assert.equal(b.tx.to,FLAP_PORTAL);assert.equal(b.tx.from,request.taker);assert.equal(b.tx.value,hex(request.amount));
 assert.equal(b.deadline,null);assert.equal(b.onchain_deadline,false);
});
test('Flap rejects non-tradable state, migrated tokens and a disabled native conversion',async()=>{
 for(const status of [0,2,3,4,5,255])await assert.rejects(new FlapRoute(quotedRPC({status}).rpc).quote(request),/FLAP_TOKEN_/);
 await assert.rejects(new FlapRoute(quotedRPC({quoteToken:BSC.usdt,nativeEnabled:false}).rpc).quote(request),/FLAP_NATIVE_BUY_NOT_ENABLED/);
});
test('quote age includes state reads; non-BNB reserves never become invented BNB liquidity',async()=>{
 const {rpc}=quotedRPC({quoteToken:BSC.usdt});const contract=rpc.contract;let stateReadAt=0;
 rpc.contract=async(...args)=>{if(args[2]==='getTokenV8Safe')stateReadAt=Date.now();return contract(...args);};
 const q=await new FlapRoute(rpc).quote(request);
 assert.ok(q.quoted_at<=stateReadAt);assert.equal(q.liquidity_bnb,null);assert.equal(q.liquidity_usd,null);
 assert.equal(q.reserve_quote_token,BSC.usdt);assert.equal(q.reserve_raw,'1000000000000000000');
});
test('Flap SELL requests only bounded approval to the Portal; stale quotes cannot build',async()=>{
 const route=new FlapRoute(quotedRPC().rpc),q=await route.quote({...request,side:'SELL'});
 const b=await route.build(q,request.taker,{max_quote_age_ms:5000});
 assert.equal(b.approval.spender,FLAP_PORTAL);assert.equal(b.approval.amount_raw,request.amount);
 assert.equal(b.tx.value,'0x0');assert.equal(FLAP.decodeFunctionData('swapExactInput',b.tx.data)[0].outputToken,ZERO);
 await assert.rejects(route.build({...q,quoted_at:0},request.taker,{max_quote_age_ms:5000}),/QUOTE_EXPIRED/);
});
test('LIVE route selection never quotes or builds Flap',async()=>{
 const route=new RouteEngine({}),called=[];
 route.providers=[{id:'FLAP_PORTAL',quote:async()=>{called.push('FLAP');throw Error('MUST_NOT_CALL');}}];
 await assert.rejects(route.quote({...request,hints:[{address:FLAP_PORTAL,adapter:'FLAP_PORTAL'}]},{live:true}),/NO_EXECUTABLE_ROUTE/);
 assert.deepEqual(called,[]);
});
test('upgrade reclassifies old raw receipts once, preserves timestamps and never queues a copy',async()=>{
 const db=sqliteDriver(':memory:'),store=new Store(db);await store.init();
 try{
  for(const f of recorded){const data={token:f.token,target_at:f.target_at,symbol:f.symbol,side:null,kind:'UNKNOWN',history:false,raw:{tx:f.tx,receipt:f.receipt}};
   await store.run("INSERT INTO copy_events VALUES (?,?,?,?,?,?,'UNKNOWN','CONFIRMED',?,?)",f.hash,f.target,f.hash,Number(BigInt(f.receipt.blockNumber)),f.receipt.blockHash,0,f.target_at,encode(data));}
  assert.equal(await recoverFlapObservations(store),3);assert.equal(await recoverFlapObservations(store),0);
  const rows=await store.all('SELECT * FROM copy_events');assert.equal(rows.length,3);
  for(const row of rows){const d=JSON.parse(row.data);assert.equal(d.history,true);assert.equal(d.side,null);assert.ok(d.observed_side);assert.equal(row.detected_at,d.target_at);}
  assert.equal((await store.get('SELECT COUNT(*) n FROM copy_actions')).n,0);
  assert.equal((await store.get('SELECT COUNT(*) n FROM copy_jobs')).n,0);
 }finally{db.close();}
});
