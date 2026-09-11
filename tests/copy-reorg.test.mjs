import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {recoverReorg,canonicalEvidence} from '../runtime/copy/reorg.mjs';
import {prepareCanonicalReinclusion} from '../runtime/copy/reorg-state.mjs';
import {applyFill} from '../core/copy/execution-policy.mjs';
import {recordTargetPosition} from '../runtime/copy/target-position.mjs';
import {writeHeartbeat} from '../runtime/copy/block-worker.mjs';
import {decode,encode} from '../core/copy/common.mjs';

const hash=n=>'0x'+n.toString(16).padStart(64,'0'),token='0x'+'a'.repeat(40);
const block=(n,fork=0,parent=null)=>({number:'0x'+n.toString(16),hash:hash(n+fork),parentHash:parent??hash(n-1+fork),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[]});
async function fixture(t,{depth=1,minority=false,disagreement=false}={}){
 const db=sqliteDriver(':memory:'),store=new Store(db,{encryptionKey:Buffer.alloc(32,12).toString('base64')});await store.init();t.after(()=>db.close());
 await store.set('engine_desired','RUNNING');await store.set('copy_config',{...await store.setting('copy_config'),enabled:true,paused:false});
 const e=new CopyEngine(store),target=(await store.all('SELECT * FROM copy_targets'))[0];e.targets=[target];
 const local=new Map(),canonical=new Map();for(let n=98;n<=100+depth;n++){local.set(n,block(n));canonical.set(n,n>=100&&!disagreement?block(n,1000,n===100?hash(99):null):block(n));}
 for(let n=98;n<100+depth;n++)await store.run('INSERT INTO copy_blocks VALUES (?,?,?,?)',n,local.get(n).hash,local.get(n).parentHash,Date.now());
 await store.set('copy_cursor',99+depth);await store.set('copy_live_cursor',99+depth);e.liveWindow={from_block:98};
 const providers=[{id:'a',enabled:true},{id:'b',enabled:true},...(minority?[{id:'c',enabled:true}]:[])],calls=[];
 e.rpc={providers,metrics:[],cooldown:new Map(),request:async(p,method,[tag,full]=[])=>{calls.push({provider:p.id,method,tag,full});if(method==='eth_chainId')return '0x38';const n=tag==='latest'?100+depth:Number(BigInt(tag));return minority&&p.id==='c'?local.get(n):canonical.get(n);}};
 e.rpc.call=async(method,params)=>e.rpc.request(providers[0],method,params);
 return {e,store,target,canonical,calls,local};
}
async function fill(f,n,side,{mode='PAPER',input='100',output='1000',fee='2',full=false}={}){
 const {store,target,local}=f,hashTx=hash(100000+n+(mode==='SHADOW'?10000:0)),eventId=target.id+':'+hashTx;
 const data={hash:hashTx,block:n,tx_index:0,token,side,kind:side,quantity_raw:side==='BUY'?output:input,target_balance_before:side==='BUY'?'0':'1000',full_exit:full,target_at:Date.now(),pools:[],raw:{receipt:{status:'0x1'}}};
 await store.run('INSERT OR IGNORE INTO copy_events VALUES (?,?,?,?,?,?,?,?,?,?)',eventId,target.id,hashTx,n,local.get(n).hash,0,side,'CONFIRMED',Date.now(),encode(data));
 await recordTargetPosition(store,target.id,data);
 const actionId=eventId+':'+mode,action={id:actionId,event_id:eventId,target_id:target.id,mode,side,token,state:'PROCESSING',epoch:0,data:encode({event:data})};
 await store.run("INSERT INTO copy_actions(id,event_id,target_id,mode,side,token,state,epoch,created_at,updated_at,data) VALUES (?,?,?,?,?,?,'PROCESSING',0,?,?,?)",actionId,eventId,target.id,mode,side,token,Date.now(),Date.now(),action.data);
 assert.equal(await applyFill(store,action,{inputRaw:input,outputRaw:output,feeRaw:fee,markPrice:1}),true);
 return {eventId,actionId,data};
}
for(const depth of [1,2])test(`${depth}-block reorg archives old blocks, replays canonical chain and resumes automatically`,async t=>{
 const f=await fixture(t,{depth});await f.e.reorg(100,'BLOCK_HASH_CHANGED');assert.equal((await f.store.setting('copy_config')).enabled,false);
 assert.equal(await recoverReorg(f.e),true);const audit=await f.store.setting('copy_reorg_last');
 assert.equal(audit.classification,'REAL_CHAIN_REORG');assert.equal(audit.reorg_depth,depth);assert.equal(audit.common_ancestor,99);
 assert.equal((await f.store.get('SELECT hash FROM copy_blocks WHERE number=100')).hash,hash(1100));
 assert.equal((await f.store.all("SELECT * FROM copy_reorg_archive WHERE table_name='copy_blocks' AND status='REORGED_OUT'")).length,depth);
 assert.equal(await f.store.setting('copy_reconciliation_required'),null);assert.equal((await f.store.setting('copy_config')).enabled,true);assert.equal((await f.store.setting('copy_config')).live_enabled,false);
 assert.equal(await recoverReorg(f.e),false);assert.equal((await f.store.all('SELECT * FROM copy_reorg_incidents')).length,1);
 assert.ok(f.calls.filter(c=>c.tag==='latest').length>=2);assert.ok(f.calls.some(c=>c.tag==='0x63'));assert.ok(f.calls.some(c=>c.tag==='0x65'));
});
test('provider disagreement quarantines only the minority and does not remove canonical state',async t=>{
 const f=await fixture(t,{minority:true,disagreement:true});const original=f.e.rpc.request;f.e.rpc.request=(p,m,args)=>p.id==='c'&&m==='eth_getBlockByNumber'?Promise.resolve(block(args[0]==='latest'?101:Number(BigInt(args[0])),5000)):original(p,m,args);
 await f.e.reorg(100,'BLOCK_HASH_CHANGED',{expected_hash:hash(5100)});assert.equal(await recoverReorg(f.e),true);
 assert.equal((await f.store.setting('copy_reorg_last')).classification,'PROVIDER_DISAGREEMENT');assert.equal((await f.store.setting('copy_reorg_last')).reorg_depth,0);
 const q=await f.store.get('SELECT * FROM copy_provider_quarantine WHERE provider=?','c');assert.equal(decode(q.data).canonical_hash,hash(100));assert.ok(q.until_at>Date.now());
 assert.equal((await f.store.all("SELECT * FROM copy_reorg_archive WHERE table_name='copy_blocks'")).length,0);
 await f.e.observe({kind:'head',provider:'c',event:{number:'0x64',hash:hash(5100)}});assert.equal(await f.store.setting('copy_reconciliation_required'),null);
});
for(const mode of ['PAPER','SHADOW'])for(const scenario of ['BUY','PARTIAL_SELL','FULL_SELL'])test(`${mode} orphan ${scenario} restores inventory, cash and closed state with full audit`,async t=>{
 const f=await fixture(t);let original=null;
 if(scenario!=='BUY'){await fill(f,99,'BUY',{mode});original=await f.store.get('SELECT * FROM copy_positions WHERE mode=?',mode);}
 const orphan=await fill(f,100,scenario==='BUY'?'BUY':'SELL',{mode,input:scenario==='FULL_SELL'?'1000':scenario==='PARTIAL_SELL'?'400':'100',output:scenario==='BUY'?'1000':'70',full:scenario==='FULL_SELL'});
 await f.store.run('INSERT INTO copy_latency_profiles VALUES (?,?,?,?)',orphan.eventId,Date.now(),Date.now(),encode({paper:{status:'FILLED'},shadow:{status:'SIMULATED',simulation:{status:'PASS'}}}));
 await f.e.reorg(100,'BLOCK_HASH_CHANGED');assert.equal(await recoverReorg(f.e),true);
 const current=await f.store.get('SELECT * FROM copy_positions WHERE mode=?',mode);
 if(!original)assert.equal(current,null);else for(const k of ['quantity_raw','cost_raw','realized_raw','opened_at','closed_at'])assert.equal(current[k],original[k],k);
 assert.equal((await f.store.get('SELECT state FROM copy_actions WHERE id=?',orphan.actionId)).state,'REORGED_OUT');
 assert.equal((await f.store.get('SELECT status FROM copy_events WHERE id=?',orphan.eventId)).status,'REORGED_OUT');
 assert.equal(await f.store.get('SELECT id FROM copy_ledger WHERE action_id=?',orphan.actionId),null);
 assert.ok(await f.store.get("SELECT * FROM copy_reorg_archive WHERE table_name='copy_ledger' AND row_key=?",orphan.actionId));
 assert.equal(decode((await f.store.get('SELECT data FROM copy_latency_profiles WHERE event_id=?',orphan.eventId)).data).shadow.status,'REORGED_OUT');
});
test('orphan reentry restores the previous closed position',async t=>{
 const f=await fixture(t);await fill(f,98,'BUY');await fill(f,99,'SELL',{input:'1000',output:'150',full:true});const original=await f.store.get('SELECT * FROM copy_positions');
 await fill(f,100,'BUY');await f.e.reorg(100,'BLOCK_HASH_CHANGED');assert.equal(await recoverReorg(f.e),true);const restored=await f.store.get('SELECT * FROM copy_positions');for(const k of ['quantity_raw','cost_raw','realized_raw','opened_at','closed_at'])assert.equal(restored[k],original[k]);
});
test('canonical replay uses stable jobs and same-hash reinclusion keeps the old inclusion archived',async t=>{
 const f=await fixture(t),orphan=await fill(f,100,'BUY');f.canonical.get(100).transactions=[{from:f.target.address,to:token,hash:orphan.data.hash,transactionIndex:'0x0'}];
 await f.e.job('tx:'+f.target.id+':'+orphan.data.hash,'TARGET',{block_number:100,target:f.target.id,hash:orphan.data.hash});
 await f.e.reorg(100,'BLOCK_HASH_CHANGED');assert.equal(await recoverReorg(f.e),true);
 const jobs=await f.store.all("SELECT * FROM copy_jobs WHERE kind='TARGET'");assert.equal(jobs.length,1);assert.equal(jobs[0].state,'QUEUED');assert.equal(decode(jobs[0].payload).block.hash,hash(1100));
 assert.equal(await prepareCanonicalReinclusion(f.store,orphan.eventId,hash(1100)),null);
 assert.ok(await f.store.get("SELECT * FROM copy_reorg_archive WHERE table_name='copy_events' AND row_key=?",orphan.eventId+':'+hash(100)));
 assert.equal((await f.store.all('SELECT * FROM copy_actions')).length,0);
 await f.e.commitCanonicalReorgBlock({height:100,expected_hash:hash(1100),reorg_id:'test'},f.canonical.get(100));assert.equal((await f.store.all("SELECT * FROM copy_jobs WHERE kind='TARGET'")).length,1);
});
test('no quorum retains all evidence and enters manual review without mutating positions',async t=>{
 const f=await fixture(t),before=await fill(f,100,'BUY');const original=f.e.rpc.request;f.e.rpc.request=(p,m,args)=>p.id==='b'?Promise.resolve(block(args[0]==='latest'?101:Number(BigInt(args[0])),5000)):original(p,m,args);
 await f.e.reorg(100,'BLOCK_HASH_CHANGED');assert.equal(await recoverReorg(f.e),false);const flag=await f.store.setting('copy_reconciliation_required');assert.equal(flag.manual_reason,'REORG_NO_PROVIDER_QUORUM');assert.equal(flag.provider_evidence.length,2);assert.equal((await f.store.get('SELECT state FROM copy_actions WHERE id=?',before.actionId)).state,'FILLED');
});
test('one endpoint aliased twice is not independent quorum',async()=>{
 await assert.rejects(canonicalEvidence({providers:[{id:'a',enabled:true,http_url:'https://same.example/x'},{id:'b',enabled:true,http_url:'https://same.example/y'}]},100),/NO_PROVIDER_QUORUM/);
});
test('unprovable derived positions fail atomically and retain original state',async t=>{
 const f=await fixture(t);await fill(f,100,'BUY');await f.store.run("UPDATE copy_positions SET cost_raw='99999'");await f.e.reorg(100,'BLOCK_HASH_CHANGED');assert.equal(await recoverReorg(f.e),false);
 assert.equal((await f.store.setting('copy_reconciliation_required')).manual_reason,'REORG_POSITION_NOT_PROVEN');assert.equal((await f.store.get('SELECT cost_raw FROM copy_positions')).cost_raw,'99999');assert.equal((await f.store.get('SELECT hash FROM copy_blocks WHERE number=100')).hash,hash(100));
});
test('recovery waits for in-flight work and honors a later user stop',async t=>{
 const f=await fixture(t);await f.e.reorg(100,'BLOCK_HASH_CHANGED');f.e.shadowTasks=new Set([1]);assert.equal(await recoverReorg(f.e),false);assert.equal(f.calls.length,0);f.e.shadowTasks.clear();
 await f.store.set('engine_desired','STOPPED');assert.equal(await recoverReorg(f.e),true);assert.equal((await f.store.setting('copy_config')).enabled,false);
});
test('legacy incident migrates and recovers without clearing the error by hand',async t=>{
 const f=await fixture(t);await f.store.set('copy_config',{...await f.store.setting('copy_config'),enabled:false,paused:true,epoch:1});await f.store.set('copy_reconciliation_required',{height:100,reason:'BLOCK_HASH_CHANGED',at:1});assert.equal(await recoverReorg(f.e),true);assert.equal((await f.store.setting('copy_config')).enabled,true);assert.equal((await f.store.setting('copy_reorg_last')).legacy,true);
 await f.store.run("INSERT INTO copy_provider_health VALUES ('a','RPC_ONLY',?,?)",encode({block:100}),Date.now());await writeHeartbeat(f.e);assert.equal((await f.store.setting('copy_runtime')).status,'WATCHING');assert.equal((await f.store.setting('copy_runtime')).unresolved_reorgs,0);
});
test('depth beyond safe limit never changes block or ledger state',async t=>{
 const f=await fixture(t,{depth:2});await f.store.set('copy_reorg_policy',{max_depth:1});await f.e.reorg(100,'BLOCK_HASH_CHANGED');assert.equal(await recoverReorg(f.e),false);assert.equal((await f.store.setting('copy_reconciliation_required')).manual_reason,'REORG_DEPTH_LIMIT');assert.equal((await f.store.get('SELECT hash FROM copy_blocks WHERE number=100')).hash,hash(100));
});
test('late provider disagreement does not masquerade as a deep reorg',async t=>{
 const f=await fixture(t,{disagreement:true});await f.store.run('INSERT INTO copy_blocks VALUES (?,?,?,?)',200,hash(200),hash(199),Date.now());await f.store.set('copy_live_cursor',200);
 await f.e.reorg(100,'BLOCK_HASH_CHANGED',{expected_hash:hash(5000)});assert.equal(await recoverReorg(f.e),true);assert.equal(await f.store.setting('copy_live_cursor'),200);assert.equal((await f.store.get('SELECT hash FROM copy_blocks WHERE number=200')).hash,hash(200));
});
test('restart after atomic rollback resumes saved canonical replay without a second rollback',async t=>{
 const f=await fixture(t),orphan=await fill(f,100,'BUY');let reached;const ready=new Promise(r=>reached=r);
 f.e.commitCanonicalReorgBlock=async()=>{reached();return new Promise(()=>{});};await f.e.reorg(100,'BLOCK_HASH_CHANGED');recoverReorg(f.e);await ready;
 const next=new CopyEngine(f.store);next.boot=f.e.boot+1;next.targets=f.e.targets;next.rpc=f.e.rpc;next.liveWindow=f.e.liveWindow;
 assert.equal(await recoverReorg(next),true);assert.equal((await f.store.get('SELECT state FROM copy_actions WHERE id=?',orphan.actionId)).state,'REORGED_OUT');
 assert.equal((await f.store.all("SELECT * FROM copy_reorg_archive WHERE table_name='copy_ledger'")).length,1);assert.equal((await f.store.get('SELECT hash FROM copy_blocks WHERE number=100')).hash,hash(1100));
});
test('fence transaction failure leaves the original watcher eligible to retry',async t=>{
 const f=await fixture(t),batch=f.store.batch.bind(f.store);f.store.batch=async()=>{throw Error('SQLITE_BUSY');};await assert.rejects(f.e.reorg(100,'BLOCK_HASH_CHANGED'),/SQLITE_BUSY/);f.store.batch=batch;assert.equal(f.e.reorgActive,false);assert.equal(await f.store.setting('copy_reconciliation_required'),null);assert.equal((await f.store.setting('copy_config')).enabled,true);
});
