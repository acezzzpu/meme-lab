import test from 'node:test';import assert from 'node:assert/strict';import bs58 from 'bs58';
import {Store} from '../core/store.mjs';import {sqliteDriver} from '../runtime/sqlite.mjs';
import {pauseEntries,controlEngine,recoverEngine,enqueue,claimJob,eventsAfter,emit} from '../core/engine-state.mjs';
import {commitPaperBuy,commitPaperSell} from '../core/paper-ledger.mjs';import {marketQueue} from '../core/scanner.mjs';
import {decodeSolanaPools,SOLANA_POOL_PROGRAMS} from '../core/pool-discovery.mjs';import {pollWallet,ingestWalletTransaction} from '../core/watchers.mjs';
import {USDC} from '../core/providers/chains.mjs';
async function memory(t){const db=sqliteDriver(':memory:');t.after(()=>db.close());const s=new Store(db);await s.init();return s;}
async function paper(t){const s=await memory(t),now=Date.now();await s.set('trading_enabled',true);await s.set('mode','PAPER');await s.run('INSERT INTO tokens VALUES (?,?,?,?,?,?,?)','solana:fixture','solana','fixture','FIX','Fixture',6,now);await s.run('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)','run','PAPER','RUNNING',1000,1000,null,JSON.stringify({reserve_pct:0}),now,null);return {s,run:{id:'run',capital_cents:1000,version_id:null,config:{reserve_pct:0}},token:{id:'solana:fixture',chain:'solana',address:'fixture',decimals:6},tradeId:'first',quantity:'1000000',price:2,quote:{inputMint:USDC,inAmount:'2000000',outputMint:'fixture',outAmount:'1000000',minOut:'1000000'},cost:203,now};}
test('pause during a pending entry prevents debit but preserves exit eligibility',async t=>{
 const f=await paper(t);assert.equal(await commitPaperBuy(f.s,f),true);const position=await f.s.get("SELECT * FROM positions WHERE id='first'");const epoch=await f.s.setting('epoch');await f.s.run('INSERT INTO tokens VALUES (?,?,?,?,?,?,?)','solana:second','solana','second','SEC','Second',6,Date.now());await pauseEntries(f.s,true);
 assert.equal(await commitPaperBuy(f.s,{...f,epoch,tradeId:'late',token:{...f.token,id:'solana:second',address:'second'}}),false);assert.equal(await f.s.setting('trading_enabled'),true);
 assert.equal(await commitPaperSell(f.s,{...f,position,tradeId:'exit',proceeds:180,quote:{...f.quote,inputMint:'fixture',outputMint:USDC}}),true);
 assert.equal((await f.s.get("SELECT cash_cents FROM runs WHERE id='run'")).cash_cents,977);
});
test('loss-limited paper session can still close an existing position',async t=>{const f=await paper(t);await commitPaperBuy(f.s,f);const position=await f.s.get("SELECT * FROM positions WHERE id='first'");await f.s.run("UPDATE runs SET status='LOSS_LIMIT'");assert.equal(await commitPaperSell(f.s,{...f,position,tradeId:'loss-exit',proceeds:100,quote:{...f.quote,outputMint:USDC}}),true);});
test('stop engine fences in-flight virtual fills and keeps position inventory',async t=>{const f=await paper(t);await controlEngine(f.s,'start',{engineAvailable:true});await commitPaperBuy(f.s,f);const position=await f.s.get("SELECT * FROM positions WHERE id='first'");await controlEngine(f.s,'stop',{engineAvailable:true});assert.equal(await commitPaperSell(f.s,{...f,position,tradeId:'late-sell',proceeds:250,quote:{...f.quote,outputMint:USDC}}),false);assert.equal((await f.s.get("SELECT closed_at FROM positions WHERE id='first'")).closed_at,null);});
test('recovery fences old epoch fills without resetting paper balance or session',async t=>{const f=await paper(t);const epoch=await f.s.setting('epoch');await recoverEngine(f.s,'new-owner');assert.equal(await commitPaperBuy(f.s,{...f,epoch}),false);assert.equal((await f.s.get("SELECT cash_cents FROM runs WHERE id='run'")).cash_cents,1000);assert.equal((await f.s.get("SELECT status FROM runs WHERE id='run'")).status,'RUNNING');});
test('two workers cannot claim the same persistent job',async t=>{const s=await memory(t);await enqueue(s,'a','WALLET_TX',{hash:'fixture'});const claimed=await Promise.all([claimJob(s,'one'),claimJob(s,'two')]);assert.equal(claimed.filter(Boolean).length,1);assert.equal(await enqueue(s,'a','WALLET_TX',{}),false);await recoverEngine(s,'three');assert.equal((await claimJob(s,'three')).id,'a');});
test('event replay uses monotonically increasing persisted IDs',async t=>{const s=await memory(t);await emit(s,'BLOCK','real event fixture',{block:'1'});const first=(await eventsAfter(s,0))[0];await emit(s,'DECISION','decision fixture',{});const replay=await eventsAfter(s,first.id);assert.equal(replay.length,1);assert.equal(replay[0].kind,'DECISION');assert.ok(replay[0].id>first.id);});
test('discovery is not starved by existing tokens and old positions get priority',()=>{
 const queue=marketQueue({chains:[{id:'solana'}],positions:[{chain:'solana',address:'old-held'}],existing:Array.from({length:40},(_,i)=>({chain:'solana',address:'existing'+i})),discovered:[{chainId:'solana',tokenAddress:'new-pool'}],limit:12,cursor:0});assert.ok(queue.some(t=>t.tokenAddress==='old-held'));assert.ok(queue.some(t=>t.tokenAddress==='new-pool'));
 const next=marketQueue({chains:[{id:'solana'}],positions:[],existing:Array.from({length:40},(_,i)=>({chain:'solana',address:'existing'+i})),discovered:[],limit:4,cursor:20});assert.ok(next.some(t=>t.tokenAddress==='existing20'));
});
test('pool detector requires successful transaction and exact creation discriminator',()=>{
 const p=SOLANA_POOL_PROGRAMS[0],tx={meta:{err:null},transaction:{message:{accountKeys:[],instructions:[{programId:p.id,accounts:['pool','config','creator','base','quote'],data:bs58.encode(Uint8Array.from(p.instructions[0].bytes))}]}}};assert.equal(decodeSolanaPools(tx)[0].address,'pool');assert.equal(decodeSolanaPools({...tx,meta:{err:'failure'}}).length,0);tx.transaction.message.instructions[0].data=bs58.encode(new Uint8Array(8));assert.equal(decodeSolanaPools(tx).length,0);
});
test('watched-wallet head catch-up is independent of historical cursor and deduplicates jobs',async t=>{
 const s=await memory(t);await s.run('INSERT INTO wallets(id,chain,address,label,created_at,cursor) VALUES (?,?,?,?,?,?)','wallet','solana','public-wallet','Fixture',1,'old-history');await s.run('INSERT INTO watched_wallets(wallet_id,head) VALUES (?,?)','wallet','old-head');
 const requests=[];t.mock.method(globalThis,'fetch',async(_url,options)=>{const p=JSON.parse(options.body).params[1];requests.push(p);return Response.json({result:p.before?[{signature:'s25'}]:Array.from({length:25},(_,i)=>({signature:'s'+i}))});});
 await pollWallet(s,'wallet');await pollWallet(s,'wallet');assert.equal((await s.get("SELECT head FROM watched_wallets WHERE wallet_id='wallet'")).head,'s0');assert.equal((await s.get("SELECT cursor FROM wallets WHERE id='wallet'")).cursor,'old-history');assert.equal(requests[1].before,'s24');assert.equal(requests[1].until,'old-head');assert.equal((await s.get('SELECT COUNT(*) n FROM engine_jobs')).n,26);
});
test('transaction replay does not duplicate wallet flows or post-trade context',async t=>{
 const s=await memory(t);await s.run('INSERT INTO wallets(id,chain,address,label,created_at) VALUES (?,?,?,?,?)','wallet','solana','owner','Fixture',1);await s.run('INSERT INTO watched_wallets(wallet_id) VALUES (?)','wallet');
 t.mock.method(globalThis,'fetch',async(url)=>String(url).includes('dexscreener')?Response.json({pairs:[]}):Response.json({result:{slot:123,blockTime:1,meta:{err:null,fee:5000,preTokenBalances:[],postTokenBalances:[{owner:'owner',mint:'mint',uiTokenAmount:{amount:'10',decimals:6}}]}}}));
 await ingestWalletTransaction(s,'wallet','signature');await ingestWalletTransaction(s,'wallet','signature');assert.equal((await s.get('SELECT COUNT(*) n FROM transactions')).n,1);assert.equal((await s.get('SELECT COUNT(*) n FROM wallet_flows')).n,1);assert.equal((await s.get('SELECT timing FROM trader_context')).timing,'UNAVAILABLE');
});
test('hosted UI cannot claim a running persistent engine without a backend',async t=>{const s=await memory(t);await assert.rejects(controlEngine(s,'start',{engineAvailable:false}),/ENGINE_NOT_PROVISIONED/);assert.equal(await s.setting('engine_desired'),'STOPPED');});

test('daily loss is fenced when a sell completes during an outstanding buy quote',async t=>{
 const f=await paper(t);f.run.config.daily_loss_cents=100;await commitPaperBuy(f.s,f);const position=await f.s.get("SELECT * FROM positions WHERE id='first'");const epoch=await f.s.setting('epoch');
 await commitPaperSell(f.s,{...f,position,tradeId:'loss',proceeds:50,quote:{...f.quote,outputMint:USDC}});
 assert.equal(await commitPaperBuy(f.s,{...f,epoch,tradeId:'late-after-loss'}),false);assert.equal((await f.s.get("SELECT cash_cents FROM runs WHERE id='run'")).cash_cents,847);
});
test('recovery retries failed durable ingestion without discarding its payload',async t=>{const s=await memory(t);await enqueue(s,'recover','SOLANA_POOL',{hash:'persisted'});await s.run("UPDATE engine_jobs SET state='FAILED',attempts=4");await recoverEngine(s,'new');const job=await claimJob(s,'new');assert.equal(job.payload.hash,'persisted');assert.equal(job.state,'RUNNING');});

test('exit monitoring rotates past provider failures without starving later positions',async t=>{
 const {monitorPaperPositions}=await import('../core/position-monitor.mjs');const {DexScreenerProvider}=await import('../core/providers/market.mjs');const f=await paper(t);await commitPaperBuy(f.s,f);
 for(let i=2;i<=5;i++)await f.s.run('INSERT INTO positions(id,run_id,chain,mode,token_id,quantity_raw,decimals,cost_cents,entry_price,opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)','p'+i,'run','solana','PAPER','solana:fixture','1',6,1,1,Date.now());
 const seen=[];t.mock.method(DexScreenerProvider.prototype,'record',async(_s,_chain,address)=>{if(address!==USDC)throw Error('PROVIDER_TIMEOUT_FIXTURE');});
 for(let i=0;i<3;i++)await monitorPaperPositions(f.s,{});
 for(const e of await f.s.all("SELECT data FROM engine_events WHERE kind='ERROR'"))seen.push(JSON.parse(e.data).position_id);
 assert.equal(new Set(seen).size,5);assert.equal(seen.length,6);
});
test('a rejected pool subscription remains degraded when slot notifications succeed',async t=>{
 const {NetworkStream}=await import('../runtime/network-streams.mjs');const s=await memory(t),stream=new NetworkStream(s,{id:'solana',family:'solana'},[],'wss://solana-rpc.publicnode.com','');stream.pending.set(1,{kind:'pool'});stream.subscriptions.set('slot',{kind:'block'});
 await stream.message(Buffer.from(JSON.stringify({id:1,error:{code:429,message:'quota fixture'}})));await stream.message(Buffer.from(JSON.stringify({params:{subscription:'slot',result:{slot:123}}})));
 const status=await s.get("SELECT * FROM ws_health WHERE chain='solana'");assert.equal(status.status,'DEGRADED');assert.equal(status.last_block,'123');assert.match(status.error,/quota/);
});
test('stopped reconciliation refreshes stale funding and fee assets before accounting',async t=>{
 const {reconcileWithPrices}=await import('../core/position-monitor.mjs');const {DexScreenerProvider}=await import('../core/providers/market.mjs');const {ExecutionEngine}=await import('../core/execution/engine.mjs');const s=await memory(t);await s.set('engine_desired','STOPPED');
 await s.run("INSERT INTO orders(id,idempotency_key,chain,mode,side,token_id,state,input_mint,output_mint,amount_raw,notional_cents,epoch,policy_revision,created_at,updated_at,build) VALUES ('pending','pending','solana','LIVE_APPROVAL','BUY','solana:asset','SUBMITTED',?,'asset','1',100,0,0,1,1,?)",USDC,JSON.stringify({feeAsset:'gas'}));
 const refreshed=[];t.mock.method(DexScreenerProvider.prototype,'record',async(_store,_chain,address)=>refreshed.push(address));let reconciled=false;t.mock.method(ExecutionEngine.prototype,'reconcile',async()=>{assert.deepEqual(new Set(refreshed),new Set([USDC,'asset','gas']));reconciled=true;});
 await reconcileWithPrices(s,{});assert.equal(reconciled,true);assert.equal(await s.setting('engine_desired'),'STOPPED');
});
