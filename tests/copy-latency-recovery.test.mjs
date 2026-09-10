import test from 'node:test';
import assert from 'node:assert/strict';
import {BscRpc} from '../runtime/copy/rpc.mjs';
import {selectQuote} from '../runtime/copy/quote-selection.mjs';
import {RouteEngine} from '../runtime/copy/routes.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {copySummary} from '../core/copy/service.mjs';
import {copyHealth,historyLabel} from '../core/copy/presentation.mjs';
import {TARGET} from '../core/copy/schema.mjs';
import {BSC,decode} from '../core/copy/common.mjs';
import {applyTaxes} from '../runtime/copy/safety.mjs';
const provider={id:'fixture',enabled:true,http_url:'https://fixture.invalid'};
const response=result=>new Response(JSON.stringify({jsonrpc:'2.0',result}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const token='0x0000000000000000000000000000000000000123';
const quote=(id,extra={})=>({provider:id,side:'BUY',token,amount_raw:'2000000000000000',out_raw:'1000000000000000000',min_out_raw:'990000000000000000',impact_pct:.1,fee_raw:'1000000000000',slippage_bps:100,quote_ms:1,quoted_at:Date.now(),liquidity_bnb:1000,...extra});

test('first compatible quote cancels a slow RPC, without a second request from that adapter',async()=>{
 let calls=0,aborts=0;
 const rpc=new BscRpc([provider],{fetcher:async(_,{signal})=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborts++;reject(signal.reason);},{once:true}));}});rpc.verified.add(provider.id);
 let started;const waiting=new Promise(r=>started=r);
 const slow={id:'PANCAKE_SMART',quote:async()=>{started();await rpc.call('eth_call',['slow']);await rpc.call('eth_call',['must-not-run']);return quote('PANCAKE_SMART');}};
 const fast={id:'PANCAKE_V2',quote:async()=>{await waiting;await delay(10);return quote('PANCAKE_V2');}};
 const result=await selectQuote([slow,fast],{}, {rpc});await delay(10);
 assert.equal(result.provider,'PANCAKE_V2');assert.equal(result.selection,'FIRST_POLICY_COMPATIBLE');assert.equal(calls,1);assert.equal(aborts,1);assert.equal(rpc.status()[0].active,0);assert.equal(rpc.cooldown.size,0);
});

test('tax-incompatible SmartRouter cannot hide a compatible tax-adjusted V2 quote',async()=>{
 const result=await selectQuote([{id:'PANCAKE_SMART',quote:async()=>quote('PANCAKE_SMART',{out_raw:'2000000000000000000'})},{id:'PANCAKE_V2',quote:async()=>{await delay(5);return quote('PANCAKE_V2');}}],{}, {validate:q=>{if(q.provider==='PANCAKE_SMART')throw Error('SMART_FEE_ON_TRANSFER_OR_UNKNOWN_UNSUPPORTED');return applyTaxes(q,{buy_tax:.02,sell_tax:.02});}});
 assert.equal(result.provider,'PANCAKE_V2');assert.equal(result.out_raw,'980000000000000000');assert.equal(result.tax_adjusted,true);assert.match(result.route_errors[0].error,/SMART_FEE/);
});

test('all failed or unverifiable routes retain individual reasons; null impact stays blocked',async()=>{
 await assert.rejects(selectQuote([{id:'PANCAKE_V2',quote:async()=>{throw Error('RPC_TIMEOUT_FIXTURE');}},{id:'ZEROX_ALLOWANCE_HOLDER',quote:async()=>quote('ZEROX_ALLOWANCE_HOLDER',{impact_pct:null})}],{}),error=>{
  assert.equal(error.message,'NO_EXECUTABLE_ROUTE');assert.equal(error.route_errors.length,2);assert.match(error.route_errors[0].error,/RPC_TIMEOUT/);assert.equal(error.route_errors[1].error,'IMPACT_UNKNOWN');return true;
 });
});

test('route deadline cancels every in-flight RPC and does not release a late quote',async()=>{
 let aborted=0;
 const rpc=new BscRpc([provider],{fetcher:async(_,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true}))});rpc.verified.add(provider.id);
 const adapters=['PANCAKE_V2','PANCAKE_SMART'].map(id=>({id,quote:async()=>{await rpc.call('eth_call',[id]);return quote(id);}}));
 await assert.rejects(selectQuote(adapters,{}, {rpc,deadlineAt:Date.now()+30}),/ROUTE_QUOTE_TIMEOUT/);await delay(5);assert.equal(aborted,2);assert.equal(rpc.status()[0].queued,0);assert.equal(rpc.status()[0].active,0);
});

test('concurrent requests verify chain once; a wrong chain never runs downstream calls',async()=>{
 for(const chain of ['0x38','0x1']){const methods=[];const rpc=new BscRpc([provider],{fetcher:async(_,{body})=>{const {method}=JSON.parse(body);methods.push(method);await delay(5);return response(method==='eth_chainId'?chain:'0x123');}});
  const results=await Promise.allSettled(Array.from({length:6},()=>rpc.call('eth_blockNumber')));assert.equal(methods.filter(m=>m==='eth_chainId').length,1);
  if(chain==='0x1'){assert.equal(methods.length,1);assert.ok(results.every(r=>r.status==='rejected'));}else assert.ok(results.every(r=>r.status==='fulfilled'));
 }
});

test('background backlog leaves RPC capacity for current observations and cancels queued work',async()=>{
 const methods=[];let started;const entered=new Promise(r=>started=r);
 const rpc=new BscRpc([provider],{maxConcurrent:2,fetcher:async(_,{body,signal})=>{const {method,params}=JSON.parse(body);methods.push(params[0]??method);if(params[0]==='old'){started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}return response('0x123');}});rpc.verified.add(provider.id);
 const controller=new AbortController();const old=rpc.withContext({priority:-1,signal:controller.signal},()=>Promise.allSettled([rpc.call('eth_call',['old']),rpc.call('eth_call',['queued-old'])]));await entered;
 assert.equal(await rpc.call('eth_blockNumber'),'0x123');assert.ok(!methods.includes('queued-old'));controller.abort(Error('TEST_CANCEL'));await old;assert.equal(rpc.status()[0].queued,0);
});

test('timeout backoff bounds retries; unsupported traces do not disable current block reads',async()=>{
 let calls=0;const rpc=new BscRpc([provider],{fetcher:async()=>{calls++;throw Error('PROVIDER_TIMEOUT');}});rpc.verified.add(provider.id);
 await assert.rejects(rpc.call('eth_blockNumber'),/PROVIDER_TIMEOUT/);await assert.rejects(rpc.call('eth_blockNumber'),/RPC_BACKOFF/);assert.equal(calls,1);
 const methods=[];const traces=new BscRpc([provider],{fetcher:async(_,{body})=>{const {method}=JSON.parse(body);methods.push(method);return method==='debug_traceTransaction'?new Response(JSON.stringify({error:{code:-32002,message:'the resource debug_traceTransaction is not available.'}})):response('0x123');}});traces.verified.add(provider.id);
 await assert.rejects(traces.call('debug_traceTransaction',['0x1']),/RPC_-32002/);await assert.rejects(traces.call('debug_traceTransaction',['0x2']),/METHOD_UNAVAILABLE_CACHED/);assert.equal(await traces.call('eth_blockNumber'),'0x123');assert.deepEqual(methods,['debug_traceTransaction','eth_blockNumber']);assert.equal(traces.cooldown.size,0);
});

test('ambiguous submission never retries a second provider',async()=>{
 const calls=[];const rpc=new BscRpc([provider,{...provider,id:'second',http_url:'https://second.invalid'}],{fetcher:async(url)=>{calls.push(url);throw Error('network timeout after submit');}});rpc.verified.add(provider.id);rpc.verified.add('second');
 await assert.rejects(rpc.call('eth_sendRawTransaction',['0x00']),/timeout/);assert.deepEqual(calls,[provider.http_url]);
});

async function fixture(t){const db=sqliteDriver(':memory:'),store=new Store(db,{encryptionKey:Buffer.alloc(32,11).toString('base64')});await store.init();t.after(()=>db.close());await store.set('engine_desired','RUNNING');await store.set('copy_config',{...await store.setting('copy_config'),enabled:true});return {store,e:new CopyEngine(store)};}
test('HEAD traffic cannot evict QUOTE/DETECTION samples from per-stage statistics',async t=>{
 const {store,e}=await fixture(t);await e.sample('QUOTE',609.4,'event','FLAP_PORTAL');await e.sample('DETECTION',1302,'event');
 await store.batch(Array.from({length:3100},(_,i)=>['INSERT INTO copy_samples VALUES (?,NULL,?,?,?,?,?)',['head-'+i,'fixture','HEAD',Date.now()+i,0,'{}']]));
 const state=await copySummary(store);assert.equal(state.latencies.QUOTE.n,1);assert.equal(state.latencies.QUOTE.p50,609.4);assert.equal(state.latencies.DETECTION.n,1);
});

test('fresh heartbeat and equal but stale block numbers never imply a current connection',()=>{
 const now=Date.now();const status=copyHealth([{status:'RPC_ONLY',updated_at:now-60000}],{at:now-1000,last_scanned_at:now-57000,observed_head:123,latest_scanned_block:123},true,now);
 assert.equal(status.process,'ACTIVO');assert.equal(status.readFresh,false);assert.equal(status.connected,false);assert.equal(status.network,'SIN DATOS RECIENTES');
 assert.equal(historyLabel({history:true,history_reason:'EXPIRED_AT_BLOCK_READ'}),'SEÑAL VENCIDA · no se copia');assert.equal(historyLabel({history:true,history_reason:'RECOVERY'}),'RECUPERADO · no se copia');
});

async function actionFixture(t,safety){
 const {store,e}=await fixture(t);await store.run("UPDATE copy_targets SET config=json_set(config,'$.min_liquidity_usd',0,'$.max_signal_age_ms',10000) WHERE id=?",TARGET);
 const event={side:'BUY',kind:'BUY',token,decimals:18,symbol:'OFFLINE_FIXTURE',quote_token:BSC.wbnb,quote_raw:'2000000000000000',quantity_raw:'1000000000000000000',price_quote:.002,target_at:Date.now(),pools:[],history:false};
 await store.run("INSERT INTO copy_events VALUES ('test-event',?,'fixture',NULL,NULL,NULL,'BUY','CONFIRMED',?,?)",TARGET,Date.now(),JSON.stringify(event));
 await e.createAction('test-event',TARGET,event,'PAPER',(await store.setting('copy_config')).epoch);
 e.safety={inspect:async()=>safety};e.routes=new RouteEngine({});e.routes.providers=[{id:'PANCAKE_V2',quote:async()=>quote('PANCAKE_V2')}];
 return {store,e,action:await store.get('SELECT * FROM copy_actions LIMIT 1')};
}
test('rejected token saves exact safety checks and received quotes, with zero fills',async t=>{
 const {store,e,action}=await actionFixture(t,{status:'FAILED',checks:{proxy:'FAILED'},buy_tax:0,sell_tax:0});await e.processAction(action);
 const row=await store.get('SELECT * FROM copy_actions WHERE id=?',action.id),data=decode(row.data);assert.equal(row.state,'REJECTED');assert.equal(data.safety.checks.proxy,'FAILED');assert.equal(data.quote_attempts.length,1);assert.ok(data.route_errors.some(r=>r.error==='TOKEN_SAFETY_FAILED'));assert.equal((await store.get('SELECT COUNT(*) n FROM copy_ledger')).n,0);
});
test('compatible PAPER quote fills once through the actual route selector',async t=>{
 const {store,e,action}=await actionFixture(t,{status:'PASSED',checks:{},buy_tax:0,sell_tax:0});await e.processAction(action);assert.equal((await store.get('SELECT state FROM copy_actions WHERE id=?',action.id)).state,'FILLED');assert.equal((await store.get('SELECT COUNT(*) n FROM copy_ledger')).n,1);
});
test('STOP arriving while a compatible quote is being prepared cannot create PAPER holdings',async t=>{
 const {store,e,action}=await actionFixture(t,{status:'PASSED',checks:{},buy_tax:0,sell_tax:0});e.routes.providers[0].quote=async()=>{await store.set('engine_desired','STOPPED');return quote('PANCAKE_V2');};await e.processAction(action);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_positions')).n,0);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_ledger')).n,0);
});

test('queued trace requests respect an unsupported response; trace timeout is not unsupported',async()=>{
 let requests=0;const rpc=new BscRpc([provider],{fetcher:async()=>{requests++;await delay(5);return new Response(JSON.stringify({error:{code:-32002,message:'the resource debug_traceTransaction is not available.'}}));}});rpc.verified.add(provider.id);
 const results=await Promise.allSettled(Array.from({length:5},(_,i)=>rpc.call('debug_traceTransaction',[String(i)])));assert.equal(requests,1);assert.ok(results.every(r=>r.status==='rejected'));
 const timeout=new BscRpc([provider],{fetcher:async()=>new Response(JSON.stringify({error:{code:-32002,message:'request timed out'}}))});timeout.verified.add(provider.id);await assert.rejects(timeout.call('debug_traceTransaction',['tx']),/timed out/);assert.equal(timeout.unsupported.size,0);assert.ok(timeout.cooldown.get(provider.id)>Date.now());
});

test('a fast quote above gas limits cannot cancel a slower affordable route',async t=>{
 const {store,e,action}=await actionFixture(t,{status:'PASSED',checks:{},buy_tax:0,sell_tax:0});e.routes.providers=[{id:'PANCAKE_SMART',quote:async()=>quote('PANCAKE_SMART',{fee_raw:'1000000000000000000'})},{id:'PANCAKE_V2',quote:async()=>{await delay(5);return quote('PANCAKE_V2');}}];await e.processAction(action);
 const row=await store.get('SELECT * FROM copy_actions WHERE id=?',action.id);assert.equal(row.state,'FILLED');const d=decode(row.data);assert.equal(d.quote.provider,'PANCAKE_V2');assert.ok(d.quote.route_errors.some(r=>r.error==='MAX_GAS_EXCEEDED'));
});

test('first route cannot replace the router pinned in an approved intent',async t=>{
 const {store,e,action}=await actionFixture(t,{status:'PASSED',checks:{},buy_tax:0,sell_tax:0});const data=decode(action.data);data.approved_intent={token,side:'BUY',epoch:action.epoch,wallet:'0x000000000000000000000000000000000000dead',provider:'PANCAKE_V2',amount_raw:'2000000000000000',min_out_raw:'990000000000000000',expires_at:Date.now()+10000};action.data=JSON.stringify(data);await store.run('UPDATE copy_actions SET data=? WHERE id=?',action.data,action.id);
 e.routes.providers=[{id:'PANCAKE_SMART',quote:async()=>quote('PANCAKE_SMART')},{id:'PANCAKE_V2',quote:async()=>{await delay(5);return quote('PANCAKE_V2');}}];await e.processAction(action);
 const row=await store.get('SELECT * FROM copy_actions WHERE id=?',action.id);assert.equal(row.state,'FILLED');assert.equal(decode(row.data).quote.provider,'PANCAKE_V2');assert.ok(decode(row.data).quote.route_errors.some(r=>r.error==='APPROVED_TERMS_CHANGED'));
});

test('PAPER buy and full mirrored sell use fresh compatible quotes and preserve integer accounting',async t=>{
 const {store,e,action}=await actionFixture(t,{status:'PASSED',checks:{},buy_tax:0,sell_tax:0});await e.processAction(action);const p=await store.get('SELECT * FROM copy_positions WHERE closed_at IS NULL');assert.ok(p);
 const event={side:'SELL',kind:'FULL_EXIT',token,decimals:18,symbol:'OFFLINE_FIXTURE',quote_token:BSC.wbnb,quote_raw:'2100000000000000',quantity_raw:p.quantity_raw,target_balance_before:p.quantity_raw,sold_fraction:1,price_quote:.0021/(Number(p.quantity_raw)/1e18),target_at:Date.now(),pools:[],history:false};
 await store.run("INSERT INTO copy_events VALUES ('sell-event',?,'fixture-sell',NULL,NULL,NULL,'FULL_EXIT','CONFIRMED',?,?)",TARGET,Date.now(),JSON.stringify(event));await e.createAction('sell-event',TARGET,event,'PAPER',(await store.setting('copy_config')).epoch);
 e.routes.providers=[{id:'PANCAKE_V2',quote:async()=>quote('PANCAKE_V2',{side:'SELL',amount_raw:p.quantity_raw,out_raw:'2100000000000000',min_out_raw:'2079000000000000'})}];await e.processAction(await store.get("SELECT * FROM copy_actions WHERE event_id='sell-event'"));
 assert.equal((await store.get("SELECT COUNT(*) n FROM copy_actions WHERE state='FILLED'")).n,2);assert.equal((await store.get('SELECT quantity_raw FROM copy_positions')).quantity_raw,'0');assert.equal((await store.get('SELECT COUNT(*) n FROM copy_positions WHERE closed_at IS NULL')).n,0);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_ledger')).n,2);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_receipts')).n,0);
});
