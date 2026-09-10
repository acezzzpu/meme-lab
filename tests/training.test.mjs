import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bs58 from 'bs58';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {handle,state} from '../core/service.mjs';
import {recoverEngine} from '../core/engine-state.mjs';
import {ExecutionEngine} from '../core/execution/engine.mjs';
import {commitPaperBuy,commitPaperSell} from '../core/paper-ledger.mjs';
import {SOL} from '../core/providers/chains.mjs';
import {PROTOCOL,featureError,candidatesFrom,splitSamples,episodeTrade,fitModel} from '../core/learning/model.mjs';
import {verifiedWalletSwaps,PUMP_AMM} from '../core/learning/solana-evidence.mjs';
import {captureTrainingSamples,trainIfReady,trainingSummary,startTrainingPaper} from '../core/learning/pipeline.mjs';

// Deliberately synthetic market fixtures. These test the fitting algorithm and
// safety controls; they never constitute evidence of a profitable real strategy.
function episodes(count=240,step=1200000){
 const base=1788000000000;
 return Array.from({length:count},(_,i)=>{const a=base+i*step,good=i%3!==2;
 const f={id:i,token_id:'solana:t'+i,price:1,liquidity:good?50000:20000,market_cap:50000,volume_5m:good?40000:12000,buys_5m:good?300:190,sells_5m:100,change_5m:good?8:4,pool_created:a-300000,received_at:a,observed_at:a,source:'SYNTHETIC_TEST_ONLY'};
 return {id:'s'+i,token_id:f.token_id,source:i%3===0?'WALLET':'MARKET',wallet_id:i%3===0?'wallet':null,anchor_at:a,end_at:a+1470000,state:'READY',features:f,evidence:{fixture:true},trajectory:Array.from({length:49},(_,j)=>({...f,id:i*100+j,received_at:a+(j+1)*30000,observed_at:a+(j+1)*30000,price:good?1+Math.min((j+1)*.05,.5):1-Math.min((j+1)*.05,.3)}))};});
}
async function memory(t){const db=sqliteDriver(':memory:');t.after(()=>db.close());const s=new Store(db);await s.init();return s;}
async function seed(s,rows){await s.batch(rows.map(r=>['INSERT INTO learning_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[r.id,r.token_id,r.source,r.wallet_id,r.anchor_at,r.end_at,r.state,r.reason??null,JSON.stringify(r.features),JSON.stringify(r.trajectory),JSON.stringify(r.evidence),null,r.end_at]]));}
async function trained(t){const s=await memory(t),rows=episodes();await seed(s,rows);await trainIfReady(s,rows.at(-1).end_at+1);const r=await s.get('SELECT * FROM learning_runs');assert.equal(r.status,'PAPER_ELIGIBLE');return {s,r,rows};}
function instruction(side='BUY'){
 const bytes=new Uint8Array(side==='BUY'?25:24);bytes.set(side==='BUY'?[102,6,61,18,1,218,235,234]:[51,230,133,164,1,127,131,173]);bytes[8]=1;
 return {programId:PUMP_AMM,accounts:['pool','owner','global','mint',SOL,'base-account','quote-account'],data:bs58.encode(bytes)};
}
function receipt(){return {slot:123,blockTime:1788000000,meta:{err:null,logMessages:['Program '+PUMP_AMM+' success'],preTokenBalances:[{accountIndex:1,owner:'owner',mint:'mint',uiTokenAmount:{amount:'0',decimals:6}}],postTokenBalances:[{accountIndex:1,owner:'owner',mint:'mint',uiTokenAmount:{amount:'90071992547409930',decimals:6}}]},transaction:{message:{accountKeys:[{pubkey:'owner',signer:true},{pubkey:'base-account'}],instructions:[instruction()]}}};}

test('actual parameter fitting creates a rule and evaluates unseen tokens after costs',()=>{
 const fit=fitModel(episodes());assert.equal(fit.trained,true);assert.equal(fit.status,'PAPER_ELIGIBLE');assert.equal(fit.parameters.min_liquidity,50000);assert.ok(fit.test.market_trades>=10);assert.ok(fit.test.pnl_cents>fit.baseline.pnl_cents);assert.ok(fit.candidate_count>1);
});
test('test outcome changes cannot influence fitted parameters or validation selection',()=>{
 const rows=episodes(),first=fitModel(rows),cutoff=first.split.test_at;
 const poisoned=rows.map(s=>s.anchor_at>=cutoff?{...s,trajectory:s.trajectory.map(p=>({...p,price:.01}))}:s);
 const second=fitModel(poisoned);assert.deepEqual(second.parameters,first.parameters);assert.deepEqual(second.validation,first.validation);assert.equal(second.status,'REJECTED');
});
test('splits are chronological, token-disjoint, purged and include incomplete tokens',()=>{
 const rows=episodes();rows.push({...rows[0],id:'repeat',anchor_at:rows.at(-1).anchor_at+1});rows[230].state='EXCLUDED';rows[230].reason='PRICE_GAP';
 const s=splitSamples(rows);const groups=[s.train,s.validation,s.test].map(a=>new Set(a.map(x=>x.token_id)));
 assert.equal([...groups[0]].some(t=>groups[1].has(t)||groups[2].has(t)),false);assert.equal([...groups[1]].some(t=>groups[2].has(t)),false);
 assert.ok(s.train.every(t=>t.end_at<s.validation_at-s.embargo_ms));assert.ok(s.validation.every(t=>t.end_at<s.test_at-s.embargo_ms));assert.ok(s.test.some(t=>t.state==='EXCLUDED'));
});
test('failed price trajectories remain risk, not removed winners',()=>{
 const rows=episodes();rows[231].state='EXCLUDED';rows[231].reason='PRICE_GAP';rows[231].trajectory=[];
 const fit=fitModel(rows);assert.equal(fit.status,'REJECTED');assert.ok(fit.test.unpriced>0);assert.ok(fit.test.worst_case_pnl_cents<fit.test.pnl_cents);
});
test('future-dated features, negative pool age and missing fields cannot create entries',()=>{
 const s=episodes()[0],p=candidatesFrom(episodes())[1];
 assert.equal(featureError({...s.features,pool_created:s.anchor_at+1}),'MISSING_POOL_AGE');
 assert.equal(episodeTrade({...s,features:{...s.features,observed_at:s.anchor_at+1}},p).state,'UNUSABLE');
 assert.equal(featureError({...s.features,liquidity:NaN}),'MISSING_LIQUIDITY');
});
test('latency uses a strictly later snapshot and missing terminal price is unpriced',()=>{
 const s=episodes()[0],params={...candidatesFrom(episodes())[1],take_profit_pct:500,stop_loss_pct:90,trailing_pct:90,max_hold_minutes:20};
 const outcome=episodeTrade(s,params);assert.equal(outcome.state,'CLOSED');assert.ok(outcome.entry_at>s.anchor_at+PROTOCOL.latency_ms);assert.equal(outcome.reason,'TIME_EXIT');
 assert.equal(episodeTrade({...s,trajectory:s.trajectory.slice(0,5)},params).state,'UNPRICED');
});
test('fees can erase profits; no zero-cost profitable claim',()=>{
 const rows=episodes().map(s=>({...s,trajectory:s.trajectory.map(p=>({...p,price:1.01}))}));
 const f=fitModel(rows);assert.equal(f.status,'REJECTED');assert.ok(f.test.pnl_cents<0);
});
test('a <24h cohort is not consumed, even if numerically large',async t=>{
 const s=await memory(t),rows=episodes(160,180000);await seed(s,rows);
 const result=await trainIfReady(s,rows.at(-1).end_at+1);assert.equal(result.reason,'OBSERVATION_SPAN');assert.equal((await s.get('SELECT COUNT(*) n FROM learning_runs')).n,0);assert.equal((await s.get('SELECT COUNT(*) n FROM learning_samples WHERE used_run_id IS NOT NULL')).n,0);
});
test('training freezes reproducible evidence and consumes holdout once without enabling money',async t=>{
 const {s,r,rows}=await trained(t);assert.equal(await s.setting('mode'),'OBSERVE');assert.equal(await s.setting('trading_enabled'),false);assert.equal((await s.setting('copy_config')).live_enabled,false);
 const d=await s.get('SELECT * FROM datasets WHERE id=?',r.dataset_id),manifest=JSON.parse(d.membership);assert.equal(manifest.samples.length,240);assert.ok(manifest.samples[0].trajectory.length>0);assert.ok(manifest.split.test.length>0);
 await trainIfReady(s,rows.at(-1).end_at+60000);assert.equal((await s.get('SELECT COUNT(*) n FROM learning_runs')).n,1);assert.equal((await s.get('SELECT COUNT(*) n FROM strategy_versions')).n,1);
});
test('oldest market-only samples do not permanently hide newer wallet samples',async t=>{
 const s=await memory(t),rows=episodes(900);
 for(let i=0;i<450;i++){rows[i].source='MARKET';rows[i].wallet_id=null;}
 await seed(s,rows);const result=await trainIfReady(s,rows.at(-1).end_at+1);
 assert.notEqual(result.reason,'INSUFFICIENT_WALLET_TRAIN');assert.ok(await s.get('SELECT id FROM learning_runs'));
});
test('first observation and profile retain exact successful direct PumpSwap buy evidence',()=>{
 const swaps=verifiedWalletSwaps(receipt(),'owner');assert.equal(swaps.length,1);assert.equal(swaps[0].side,'INFERRED_BUY');assert.equal(swaps[0].delta_raw,'90071992547409930');assert.equal(swaps[0].quote_value,null);
});
test('buy then sell net positive is not mislabeled as one buy',()=>{
 const tx=receipt();tx.transaction.message.instructions.push(instruction('SELL'));assert.deepEqual(verifiedWalletSwaps(tx,'owner'),[]);
});
test('failed, CPI-only, unrelated wallet, missing owner and malformed swaps are excluded',()=>{
 const tx=receipt();tx.meta.err={InstructionError:[0,'failed']};assert.deepEqual(verifiedWalletSwaps(tx,'owner'),[]);
 const cpi=receipt();cpi.meta.innerInstructions=[{index:0,instructions:cpi.transaction.message.instructions}];cpi.transaction.message.instructions=[];assert.deepEqual(verifiedWalletSwaps(cpi,'owner'),[]);
 assert.deepEqual(verifiedWalletSwaps(receipt(),'someone-else'),[]);
 const missing=receipt();delete missing.meta.postTokenBalances[0].owner;assert.deepEqual(verifiedWalletSwaps(missing,'owner'),[]);
 const malformed=receipt();malformed.transaction.message.instructions[0].data='bad!';assert.deepEqual(verifiedWalletSwaps(malformed,'owner'),[]);
});
test('no-op real Solana receipt is not training data',async()=>{
 const d=JSON.parse(await readFile(new URL('../docs/evidence/provider-verification.json',import.meta.url),'utf8'));
 assert.ok(d.wallet_test.transaction);assert.deepEqual(verifiedWalletSwaps(d.wallet_test.transaction,'4BQ6ATUt26GFdiYQfht23iwfKyYD9D7XbL5ATqNGk3xK'),[]);
});
test('compiled static keys resolve loaded addresses without fabricating an owner',()=>{
 const tx=receipt(),keys=['owner','base-account','pool','global','mint',SOL,'quote-account',PUMP_AMM];
 tx.transaction.message={staticAccountKeys:keys.slice(0,2),compiledInstructions:[{programIdIndex:7,accountKeyIndexes:[2,0,3,4,5,1,6],data:instruction().data}]};tx.meta.loadedAddresses={writable:keys.slice(2),readonly:[]};assert.equal(verifiedWalletSwaps(tx,'owner').length,1);
});
test('capture keeps missing prices and restart does not reset observations',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'meme-training-'));t.after(()=>rm(folder,{recursive:true,force:true}));let db=sqliteDriver(join(folder,'data.sqlite')),s=new Store(db);await s.init();const [row]=episodes();row.state='CAPTURING';row.trajectory=[];await seed(s,[row]);
 await captureTrainingSamples(s,row.anchor_at+PROTOCOL.max_gap_ms+1);assert.equal((await s.get('SELECT state FROM learning_samples')).state,'EXCLUDED');
 await s.set('training_lease',{owner:'crashed',until:Date.now()+120000});db.close();db=sqliteDriver(join(folder,'data.sqlite'));s=new Store(db);await s.init();await recoverEngine(s,'new');assert.equal((await s.get('SELECT state FROM learning_samples')).state,'EXCLUDED');assert.equal(await s.setting('training_lease'),null);db.close();
});
test('qualified strategy starts one $100 virtual session and never changes copy capital',async t=>{
 const {s,r}=await trained(t),copy=await s.setting('copy_config');
 const run=await startTrainingPaper(s,r.id,{engineAvailable:true});assert.equal(run.mode,'PAPER');assert.equal(run.capital_cents,10000);assert.equal(await s.setting('engine_desired'),'RUNNING');assert.deepEqual(await s.setting('copy_config'),copy);
 const again=await startTrainingPaper(s,r.id,{engineAvailable:true});assert.equal(again.id,run.id);assert.equal((await s.get('SELECT COUNT(*) n FROM runs')).n,1);
 const summary=await trainingSummary(s);assert.equal(summary.runs[0].paper.review_ready,false);assert.equal(summary.runs[0].paper.live_enabled,false);
});
test('training cannot start configured LIVE copy',async t=>{
 const {s,r}=await trained(t);const copy=await s.setting('copy_config');await s.set('copy_config',{...copy,live_enabled:true});
 await assert.rejects(startTrainingPaper(s,r.id,{engineAvailable:true}),/STOP_LIVE_COPY/);await assert.rejects(handle(s,'training/start','POST',{}, {engineAvailable:true}),/STOP_LIVE_COPY/);assert.equal(await s.setting('engine_desired'),'STOPPED');assert.equal((await s.get('SELECT COUNT(*) n FROM runs')).n,0);
});
test('training start cannot resume the main LIVE automation engine',async t=>{
 const s=await memory(t);await s.set('mode','LIVE_APPROVAL');
 await assert.rejects(handle(s,'training/start','POST',{}, {engineAvailable:true}),/STOP_LIVE_BEFORE_TRAINING/);
 assert.equal(await s.setting('engine_desired'),'STOPPED');
});
test('training cannot resume an unresolved copy transaction after LIVE was disarmed',async t=>{
 const {s,r}=await trained(t),now=Date.now();await s.run("INSERT INTO copy_actions(id,event_id,target_id,mode,side,state,epoch,created_at,updated_at,data) VALUES ('pending','event','target','LIVE_AUTO','BUY','SUBMISSION_UNKNOWN',0,?,?,'{}')",now,now);
 await assert.rejects(startTrainingPaper(s,r.id,{engineAvailable:true}),/PENDING_LIVE_COPY/);assert.equal((await s.get('SELECT COUNT(*) n FROM runs')).n,0);
});
test('learned PAPER run books buys and exits under the frozen version and preserves costs',async t=>{
 const {s,r}=await trained(t),started=await startTrainingPaper(s,r.id,{engineAvailable:true}),row=await s.get('SELECT * FROM runs WHERE id=?',started.id),run={...row,config:JSON.parse(row.config)},now=Date.now();
 const token={id:'solana:paper-fixture',chain:'solana',address:'paper-fixture',decimals:6};await s.run('INSERT INTO tokens VALUES (?,?,?,?,?,?,?)',token.id,token.chain,token.address,'FIXTURE',null,6,now);
 const quote={inputMint:'USDC_FIXTURE',inAmount:'2000000',outputMint:token.address,outAmount:'1000000',minOut:'990000',slippageBps:100,provider:'TEST_QUOTE_NOT_REAL'};
 assert.equal(await commitPaperBuy(s,{run,token,tradeId:'training-buy',quantity:'1000000',price:2,quote,cost:203,now}),true);
 const position=await s.get("SELECT * FROM positions WHERE id='training-buy'");assert.equal(position.version_id,r.version_id);
 assert.equal(await commitPaperSell(s,{run,position,token,tradeId:'training-sell',proceeds:220,quote:{...quote,inputMint:token.address,outputMint:'USDC_FIXTURE'},now:now+1000}),true);
 assert.equal((await s.get('SELECT cash_cents FROM runs WHERE id=?',run.id)).cash_cents,10017);
 assert.equal((await s.get("SELECT realized_cents FROM positions WHERE id='training-buy'")).realized_cents,17);
 assert.equal((await trainingSummary(s)).runs[0].paper.review_ready,false);
});
test('rejected learned versions cannot enter PAPER, SHADOW or LIVE through generic endpoints',async t=>{
 const s=await memory(t),vid='00000000-0000-4000-8000-000000000001';await s.run('INSERT INTO strategy_versions VALUES (?,?,?,?,?,?,?)',vid,'x',1,1,'{}',null,'TRAINED_REJECTED');
 const engine=new ExecutionEngine(s);await assert.rejects(engine.create({version_id:vid,mode:'LIVE_APPROVAL'}),/TRAINED_STRATEGY_PAPER_ONLY/);
 await assert.rejects(handle(s,'automation/settings','POST',{version_id:vid,order_cents:200},{engineAvailable:true}),/TRAINED_STRATEGY_PAPER_ONLY/);
});
test('new endpoint and state show truthful empty dataset instead of fake trained status',async t=>{
 const s=await memory(t),st=await state(s,{engineAvailable:true});assert.equal(st.training.ready,0);assert.equal(st.training.runs.length,0);assert.equal(st.training.status,null);
 await handle(s,'training/start','POST',{}, {engineAvailable:true});assert.equal((await s.get("SELECT type FROM engine_jobs WHERE id='training-request'")).type,'TRAINING');
 await handle(s,'training/pause','POST',{}, {engineAvailable:true});assert.equal((await s.setting('training_config')).enabled,false);
});
