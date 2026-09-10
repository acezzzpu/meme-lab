import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderHttp,retryAfterMs} from '../core/provider-http.mjs';
import {DexScreenerProvider,recordMarketError} from '../core/providers/market.mjs';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {monitorPaperPositions} from '../core/position-monitor.mjs';
import {scanOnce,marketQueue} from '../core/scanner.mjs';
import {paperTick} from '../core/paper.mjs';
import {JupiterExecutor} from '../core/execution/solana.mjs';
import {USDC,SOL,SolanaAdapter} from '../core/providers/chains.mjs';
import {baseline,saveStrategy} from '../core/strategy.mjs';
import {enqueue,claimJob} from '../core/engine-state.mjs';

const unlimited=()=>({concurrency:2,spacing:0});
async function memory(t){const db=sqliteDriver(':memory:');t.after(()=>db.close());const store=new Store(db);await store.init();return store;}
async function snapshot(store,address,price=1,receivedAt=Date.now()){
 const tokenId='solana:'+address;await store.run('INSERT OR IGNORE INTO tokens(id,chain,address,decimals,first_seen) VALUES (?,?,?,?,?)',tokenId,'solana',address,6,receivedAt);
 await store.run('INSERT INTO market_snapshots(token_id,observed_at,received_at,price,source,raw) VALUES (?,?,?,?,?,?)',tokenId,receivedAt,receivedAt,price,'controlled test fixture','{}');return tokenId;
}
async function session(store){
 await store.set('trading_enabled',true);await store.set('mode','PAPER');
 const config={...baseline,order_cents:200,network_fee_cents:3,reserve_pct:0,max_positions:2,daily_loss_cents:1000,slippage_bps:100,max_impact_pct:2};
 await store.run('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)','run','PAPER','RUNNING',10000,10000,null,JSON.stringify(config),Date.now(),null);return store.get("SELECT * FROM runs WHERE id='run'");
}

test('429 applies Retry-After across all paths; another provider stays available and retry recovers',async()=>{
 let at=100000,calls=0;const request=createProviderHttp({now:()=>at,policy:unlimited,fetcher:async()=>++calls===1?new Response('',{status:429,headers:{'Retry-After':'20'}}):Response.json({ok:true})});
 await assert.rejects(request('https://limited.example/one'),/PROVIDER_HTTP_429/);
 await assert.rejects(request('https://limited.example/two'),e=>e.retryAt===120000&&e.message.includes('COOLDOWN'));
 assert.equal(calls,1);assert.deepEqual(await request('https://independent.example/one'),{ok:true});
 at=119999;await assert.rejects(request('https://limited.example/one'),/COOLDOWN/);assert.equal(calls,2);
 at=120000;assert.deepEqual(await request('https://limited.example/one'),{ok:true});assert.equal(calls,3);
 assert.equal(retryAfterMs(new Date(at+30000).toUTCString(),at),30000);
});
test('concurrent success cannot erase a newer rate limit',async()=>{
 const pending=[];const request=createProviderHttp({policy:unlimited,fetcher:()=>new Promise(resolve=>pending.push(resolve))});
 const a=request('https://race.example/a'),b=request('https://race.example/b');
 pending[0](new Response('',{status:429}));await assert.rejects(a,/429/);
 pending[1](Response.json({ok:true}));await b;
 await assert.rejects(request('https://race.example/c'),/COOLDOWN/);assert.equal(pending.length,2);
});
test('timeout pauses a provider and the next scheduled request can recover; no automatic POST replay',async()=>{
 let at=0,calls=0;const request=createProviderHttp({now:()=>at,policy:unlimited,fetcher:async()=>{calls++;if(calls===1)throw new DOMException('timed out','TimeoutError');return Response.json({ok:true});}});
 await assert.rejects(request('https://timeout.example/rpc',{method:'POST',body:'{"method":"sendTransaction"}'}),/PROVIDER_TIMEOUT/);
 assert.equal(calls,1);await assert.rejects(request('https://timeout.example/rpc'),/COOLDOWN/);assert.equal(calls,1);
 at=1000;assert.deepEqual(await request('https://timeout.example/rpc'),{ok:true});
});
test('provider requests respect concurrency without blocking a separate host',async()=>{
 let active=0,maximum=0;const request=createProviderHttp({policy:()=>({concurrency:1,spacing:0}),fetcher:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,5));active--;return Response.json({ok:true});}});
 await Promise.all([1,2,3].map(i=>request('https://serial.example/'+i)));assert.equal(maximum,1);
});
test('queue timeout identifies the provider and never sends or retries the delayed request',async()=>{
 let calls=0;const request=createProviderHttp({timeoutMs:15,policy:()=>({concurrency:1,spacing:80}),fetcher:async()=>{calls++;return Response.json({ok:true});}});
 await request('https://queue.example/one');await assert.rejects(request('https://queue.example/two'),e=>e.provider==='queue.example'&&e.message.startsWith('PROVIDER_QUEUE_TIMEOUT')&&e.retryAt>Date.now());assert.equal(calls,1);
});
test('SCAN and exits share one request and recent observations retain original timestamps',async t=>{
 const store=await memory(t),calls=[];
 t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));const addresses=String(url).split('/').at(-1).split(',');return Response.json(addresses.map(address=>({chainId:'solana',pairAddress:'pool-'+address,baseToken:{address,symbol:address},priceUsd:'1',liquidity:{usd:100000}})));});
 const a=new DexScreenerProvider(),b=new DexScreenerProvider();await Promise.all([a.record(store,'solana','A'),b.record(store,'solana','A'),b.record(store,'solana','B')]);
 assert.equal(calls.length,1);assert.match(calls[0],/\/tokens\/v1\/solana\/A,B$/);
 const before=await store.get("SELECT * FROM market_snapshots WHERE token_id='solana:A'");await a.record(store,'solana','A');
 assert.equal(calls.length,1);assert.equal((await store.get('SELECT COUNT(*) n FROM market_snapshots')).n,2);assert.equal((await store.get("SELECT received_at FROM market_snapshots WHERE token_id='solana:A'")).received_at,before.received_at);
 await recordMarketError(store,Error('NO_INDEXED_POOLS'));assert.equal((await store.get("SELECT status FROM provider_health WHERE id='market'")).status,'CONNECTED');
});
test('PAPER keeps USDC refreshed with zero positions and does not invent a price',async t=>{
 const store=await memory(t);await session(store);const calls=[];
 t.mock.method(DexScreenerProvider.prototype,'record',async(s,_chain,address)=>{calls.push(address);return snapshot(s,address,.997);});
 await monitorPaperPositions(store,{});await monitorPaperPositions(store,{});
 assert.deepEqual(calls,[USDC]);assert.equal((await store.get('SELECT price FROM market_snapshots')).price,.997);assert.equal((await store.get('SELECT COUNT(*) n FROM orders')).n,0);
});
test('funding is refreshed before discovery; empty cycles do not produce repeated PAPER entry warnings',async t=>{
 const store=await memory(t);await session(store);await store.run("UPDATE chains SET enabled=CASE WHEN id='solana' THEN 1 ELSE 0 END");
 const calls=[];t.mock.method(DexScreenerProvider.prototype,'record',async(s,_chain,address)=>{calls.push(address);return snapshot(s,address);});
 t.mock.method(DexScreenerProvider.prototype,'discover',async()=>{assert.deepEqual(calls.slice(0,2),[USDC,SOL]);return [];});
 await scanOnce(store,{skipHealth:true,skipReconcile:true,skipExits:true});
 assert.equal((await store.get("SELECT COUNT(*) n FROM engine_events WHERE message='PAPER espera un precio reciente de USDC'")).n,0);
 const queue=marketQueue({chains:[{id:'solana'}],positions:Array.from({length:5},(_,i)=>({chain:'solana',address:'held'+i})),existing:[],discovered:[]});assert.equal(queue[0].tokenAddress,USDC);
});
test('missing or stale USDC blocks an actual entry without a quote or ledger change',async t=>{
 const store=await memory(t),run=await session(store);await snapshot(store,'ASSET');let calls=0;
 t.mock.method(JupiterExecutor.prototype,'quote',async()=>{calls++;throw Error('must not quote');});
 const signals=[{id:'signal',token_id:'solana:ASSET',observed_at:Date.now(),score:90}];await paperTick(store,run,signals,{skipExits:true});
 await snapshot(store,USDC,1,Date.now()-46000);await paperTick(store,run,signals,{skipExits:true});
 assert.equal(calls,0);assert.equal((await store.get('SELECT COUNT(*) n FROM orders')).n,0);assert.equal((await store.get('SELECT cash_cents FROM runs')).cash_cents,10000);
});
test('a quote that outlives its USDC observation cannot book a virtual fill',async t=>{
 const store=await memory(t),run=await session(store);let at=Date.now();t.mock.method(Date,'now',()=>at);
 await snapshot(store,USDC,1,at-44000);await snapshot(store,'ASSET',1,at);
 t.mock.method(JupiterExecutor.prototype,'quote',async()=>{at+=2000;return {inputMint:USDC,outputMint:'ASSET',inAmount:'2000000',outAmount:'2000000',minOut:'1980000',slippageBps:100,priceImpactPct:.1,quotedAt:at};});
 await paperTick(store,run,[{id:'signal',token_id:'solana:ASSET',observed_at:at,score:90}],{skipExits:true});
 assert.equal((await store.get('SELECT COUNT(*) n FROM orders')).n,0);assert.equal((await store.get('SELECT cash_cents FROM runs')).cash_cents,10000);
 assert.match((await store.get("SELECT data FROM engine_events WHERE message='Entrada PAPER rechazada'")).data,/STALE_USDC_PRICE_AFTER_QUOTE/);
});
test('a reserved worker slot skips pool work and can claim a price/exit job',async t=>{
 const store=await memory(t);await enqueue(store,'pool','SOLANA_POOL',{hash:'fixture'});
 assert.equal(await claimJob(store,'reserved',['PAPER_EXITS','RECONCILE']),null);
 await enqueue(store,'prices','PAPER_EXITS');assert.equal((await claimJob(store,'reserved',['PAPER_EXITS','RECONCILE'])).id,'prices');
 assert.equal((await claimJob(store,'background')).id,'pool');
});
test('fresh USDC cannot authorize a buy from a signal that expired during the quote',async t=>{
 const store=await memory(t),run=await session(store);let at=Date.now();t.mock.method(Date,'now',()=>at);
 await snapshot(store,USDC,1,at);await snapshot(store,'ASSET',1,at);
 t.mock.method(JupiterExecutor.prototype,'quote',async()=>{at+=2000;return {inputMint:USDC,outputMint:'ASSET',inAmount:'2000000',outAmount:'2000000',minOut:'1980000',slippageBps:100,priceImpactPct:.1,quotedAt:at};});
 await paperTick(store,run,[{id:'old-signal',token_id:'solana:ASSET',observed_at:at-44000,score:90}],{skipExits:true});
 assert.equal((await store.get('SELECT COUNT(*) n FROM orders')).n,0);assert.equal((await store.get('SELECT cash_cents FROM runs')).cash_cents,10000);
 assert.match((await store.get("SELECT data FROM engine_events WHERE message='Entrada PAPER rechazada'")).data,/STALE_SIGNAL_AFTER_QUOTE/);
});
test('multiple matching strategies share a single failed metadata attempt per token',async t=>{
 const store=await memory(t);await store.run("UPDATE chains SET enabled=CASE WHEN id='solana' THEN 1 ELSE 0 END");
 await saveStrategy(store,'First',baseline);await saveStrategy(store,'Second',baseline);await snapshot(store,'ASSET');await store.run("UPDATE tokens SET decimals=NULL WHERE address='ASSET'");
 await store.run('INSERT INTO pools VALUES (?,?,?,?,?,?,?)','pool','solana:ASSET','solana','pool','fixture',Date.now()-60000,'fixture');
 t.mock.method(DexScreenerProvider.prototype,'discover',async()=>[]);
 t.mock.method(DexScreenerProvider.prototype,'record',async(s,_chain,address)=>{const tokenId=await snapshot(s,address);if(address==='ASSET')await s.run("UPDATE market_snapshots SET pool_id='pool',liquidity=20000,market_cap=50000,volume_5m=12000,buys_5m=20,sells_5m=10,change_5m=5 WHERE token_id=?",tokenId);return tokenId;});
 let calls=0;t.mock.method(SolanaAdapter.prototype,'token',async()=>{calls++;throw Error('RPC fixture unavailable');});
 await scanOnce(store,{skipHealth:true,skipReconcile:true,skipExits:true});assert.equal(calls,1);assert.equal((await store.get("SELECT COUNT(*) n FROM signals WHERE decision='SIGNAL'")).n,2);assert.equal((await store.get("SELECT decimals FROM tokens WHERE address='ASSET'")).decimals,null);
});
