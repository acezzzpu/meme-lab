// Regression specifications against real CopyEngine, no network or signer.
// Execute: node --test /tmp/copy-queue-bug-repro.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {TARGET} from '../core/copy/schema.mjs';
import {decode} from '../core/copy/common.mjs';
import {blockWork,writeHeartbeat,runLoop} from '../runtime/copy/block-worker.mjs';
import {handleCopy} from '../core/copy/service.mjs';
import {copyTime} from '../core/copy/presentation.mjs';
const h=n=>'0x'+n.toString(16).padStart(64,'0');
const hash=h(123456);
async function fixture(t){
 const db=sqliteDriver(':memory:'),store=new Store(db,{encryptionKey:Buffer.alloc(32,12).toString('base64')});
 await store.init();t.after(()=>db.close());
 await store.set('copy_config',{...await store.setting('copy_config'),enabled:true});await store.set('engine_desired','RUNNING');const e=new CopyEngine(store);e.targets=await store.all('SELECT * FROM copy_targets');
 const calls=[];e.rpc={metrics:[],call:async(method,[tag])=>{
  assert.equal(method,'eth_getBlockByNumber');const n=Number(BigInt(tag));calls.push(n);
  return {number:tag,hash:h(n),parentHash:h(n-1),timestamp:'0x1',transactions:[]};
 }};
 return {e,store,calls,db};
}
test('regression: a recovery alias of an already persisted block must not fetch it again',async t=>{
 const {e,calls}=await fixture(t);
 await e.block({height:100,method:'HTTP_FALLBACK',provider:'a',received_at:Date.now()});
 await e.block({height:100,method:'RECOVERY',history:true,provider:'a',received_at:Date.now()});
 assert.deepEqual(calls,[100], 'current implementation fetched one block twice under live/recovery job aliases');
});
test('regression: new head detection must not wait behind 32 historic recovery fetches',async t=>{
 const {e,store}=await fixture(t);await store.set('copy_cursor',100);
 for(let n=101;n<=132;n++)await e.job('head:'+n,'BLOCK',{height:n,history:true,method:'RECOVERY'},0);
 await e.observe({kind:'head',provider:'public',method:'HTTP_FALLBACK',event:{number:'0x12c'},received_at:Date.now()});
 const processed=[];e.block=async p=>processed.push(p);
 await blockWork(e,false);
 assert.equal(processed[0]?.height,300, 'new latest block was starved by older catchup queue');
});
test('regression: crash before target jobs are durable cannot mark their block completely scanned',async t=>{
 const {e,store}=await fixture(t);
 e.rpc.call=async()=>({number:'0x64',hash:h(100),parentHash:h(99),timestamp:'0x1',transactions:[{from:TARGET,hash}]});
 await store.driver.exec("CREATE TRIGGER fail_target BEFORE INSERT ON copy_jobs WHEN NEW.kind='TARGET' BEGIN SELECT RAISE(ABORT,'TEST_DISK_FAILURE_BEFORE_TARGET_ENQUEUE'); END;");
 await assert.rejects(e.block({height:100,provider:'public',method:'HTTP_FALLBACK',received_at:Date.now()}),/TEST_DISK_FAILURE/);
 assert.equal(await store.get('SELECT number FROM copy_blocks WHERE number=100'),null, 'block falsely marked scanned before its target jobs were durable');
});
test('control: recovery jobs remain historical and cannot silently become executable trades',async t=>{
 const {e,store}=await fixture(t);await store.set('copy_cursor',90);
 e.rpc.call=async()=>({number:'0x64',hash:h(100),parentHash:h(99),timestamp:'0x1',transactions:[{from:TARGET,hash}]});
 await e.block({height:100,provider:'public',method:'RECOVERY',history:true,received_at:Date.now()});
 const row=await store.get("SELECT payload FROM copy_jobs WHERE kind='TARGET'");assert.ok(row);
 assert.equal(decode(row.payload).history,true);
});
test('control: contiguous cursor never skips an unscanned height',async t=>{
 const {e,store}=await fixture(t);await store.set('copy_cursor',100);
 await e.block({height:104,method:'HTTP_FALLBACK',provider:'a',received_at:Date.now()});
 assert.equal(await store.setting('copy_cursor'),100);
 for(const height of [102,103])await e.block({height,method:'RECOVERY',history:true,provider:'a',received_at:Date.now()});
 assert.equal(await store.setting('copy_cursor'),100);
 await e.block({height:101,method:'RECOVERY',history:true,provider:'a',received_at:Date.now()});
 assert.equal(await store.setting('copy_cursor'),104);
});
test('regression: HTTP and WSS observations of one height share one queued block scan',async t=>{
 const {e,store}=await fixture(t);
 await e.observe({kind:'head',provider:'http',method:'HTTP_FALLBACK',event:{number:'0x64'},received_at:Date.now()});
 await e.observe({kind:'head',provider:'wss',method:'WEBSOCKET',event:{number:'0x64',hash:h(100)},received_at:Date.now()});
 assert.equal((await store.get("SELECT COUNT(*) n FROM copy_jobs WHERE kind='BLOCK' AND state='QUEUED'")).n,1);
});
test('control: a changed explicit block hash cannot be hidden by the persisted-block cache',async t=>{
 const {e,store}=await fixture(t);
 await e.block({height:100,method:'WEBSOCKET',expected_hash:h(100),provider:'a',received_at:Date.now()});
 e.rpc.call=async()=>({number:'0x64',hash:h(100000),parentHash:h(99),timestamp:'0x1',transactions:[]});
 await e.block({height:100,method:'WEBSOCKET',expected_hash:h(100000),provider:'a',received_at:Date.now()});
 assert.ok(await store.setting('copy_reconciliation_required'), 'hash conflict requires reconciliation, never silent deduplication');
});

test('independent current lane completes two heads while a historical RPC remains unresolved',async t=>{
 const {e,store,calls}=await fixture(t);await store.set('copy_cursor',100);
 await e.job('head:101','BLOCK',{height:101,history:true,method:'RECOVERY'});
 let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});const rpc=e.rpc.call;
 e.rpc.call=async(method,args)=>{if(args[0]==='0x65'){entered();await new Promise(resolve=>{release=resolve;});}return rpc(method,args);};
 const historical=blockWork(e,true);await waiting;
 for(const n of [300,301]){await e.observe({kind:'head',provider:'public',method:'HTTP_FALLBACK',event:{number:'0x'+n.toString(16)},received_at:Date.now()});assert.equal(await blockWork(e,false),true);assert.ok(await store.get('SELECT number FROM copy_blocks WHERE number=?',n));}
 assert.equal(await store.setting('copy_cursor'),100);assert.deepEqual(calls,[300,301]);
 release();await historical;assert.equal(await store.setting('copy_cursor'),101);
});
test('457-block upload backlog recovers with no missing heights, duplicate RPCs or copy actions',async t=>{
 const {e,store,calls}=await fixture(t);const cursor=121020452,head=121020909;await store.set('copy_cursor',cursor);
 for(let n=cursor+1;n<=cursor+32;n++){await e.job('head:'+n,'BLOCK',{height:n,method:'RECOVERY',history:true});await e.job('head:'+n+':http','BLOCK',{height:n,method:'RECOVERY',history:true});}
 await e.observe({kind:'head',provider:'public',method:'HTTP_FALLBACK',event:{number:'0x'+head.toString(16)},received_at:Date.now()});await blockWork(e,false);assert.equal(calls[0],head);
 for(let i=0;i<500&&await store.setting('copy_cursor')<head;i++)await blockWork(e,true);
 assert.equal(await store.setting('copy_cursor'),head);assert.equal(new Set(calls).size,457);assert.equal(calls.length,457);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_blocks')).n,457);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_actions')).n,0);
});
test('contradictory hash received during a read survives deduplication and fences copying',async t=>{
 const {e,store}=await fixture(t);let release,entered;const pending=new Promise(resolve=>{entered=resolve;});const original=e.rpc.call;
 await e.observe({kind:'head',provider:'wss',method:'WEBSOCKET',event:{number:'0x64',hash:h(100)},received_at:Date.now()});
 e.rpc.call=async(...args)=>{entered();await new Promise(resolve=>release=resolve);return original(...args);};const first=blockWork(e,false);await pending;
 await e.observe({kind:'head',provider:'wss',method:'WEBSOCKET',event:{number:'0x64',hash:h(100000)},received_at:Date.now()});release();await first;
 const remaining=await store.get("SELECT * FROM copy_jobs WHERE kind='BLOCK' AND state='QUEUED'");assert.equal(decode(remaining.payload).expected_hash,h(100000));
 e.rpc.call=async()=>({number:'0x64',hash:h(100000),parentHash:h(99),timestamp:'0x1',transactions:[]});await blockWork(e,false);
 assert.ok(await store.setting('copy_reconciliation_required'));assert.equal((await store.setting('copy_config')).enabled,false);
});
test('atomic block transaction rolls back earlier target jobs when its block marker fails',async t=>{
 const {e,store}=await fixture(t);e.rpc.call=async()=>({number:'0x64',hash:h(100),parentHash:h(99),timestamp:'0x1',transactions:[{from:TARGET,hash}]});
 await store.driver.exec("CREATE TRIGGER fail_block BEFORE INSERT ON copy_blocks BEGIN SELECT RAISE(ABORT,'TEST_BLOCK_MARKER_FAILURE'); END;");
 await assert.rejects(e.block({height:100,method:'RECOVERY',history:true}),/TEST_BLOCK_MARKER_FAILURE/);
 assert.equal((await store.get("SELECT COUNT(*) n FROM copy_jobs WHERE kind='TARGET'")).n,0);assert.equal(await store.setting('copy_cursor'),null);
 await store.driver.exec('DROP TRIGGER fail_block;');await e.block({height:100,method:'RECOVERY',history:true});await e.block({height:100,method:'RECOVERY',history:true});
 assert.equal((await store.get("SELECT COUNT(*) n FROM copy_jobs WHERE kind='TARGET'")).n,1);assert.equal(await store.setting('copy_cursor'),100);
});
test('heartbeat/export distinguish current reading from historical coverage without provider secrets',async t=>{
 const {e,store}=await fixture(t);await store.set('copy_cursor',100);await store.set('copy_observed_head',557);
 await e.block({height:557,method:'HTTP_FALLBACK'});await e.health('public','RPC_ONLY',{block:557});e.rpc.metrics=[{provider:'public',method:'eth_getBlockByNumber',duration_ms:200,status:'OK'}];
 await e.report('ERROR','BLOCK · timeout',{provider:'public',height:101});await store.set('copy_providers',[{id:'private',enabled:true,http_url:'https://example.com/private-token?api-key=secret-test-value',ws_url:'wss://example.com/private-token',pending:'NONE'}]);await writeHeartbeat(e);
 const out=await handleCopy(store,'copy/export','GET',{},{});
 assert.equal(out.state.runtime.status,'RECOVERING');assert.equal(out.state.runtime.observed_head,557);assert.equal(out.state.runtime.latest_scanned_block,557);assert.equal(out.state.runtime.cursor,100);assert.equal(out.state.runtime.block_lag,457);assert.equal(out.state.runtime.missing_blocks,456);assert.ok(out.jobs.length>0);assert.equal(out.feed[0].message,'BLOCK · timeout');assert.equal(out.state.runtime.last_rpc[0].duration_ms,200);assert.equal(JSON.stringify(out).includes('secret-test-value'),false);assert.equal(JSON.stringify(out).includes('private-token'),false);
});
test('STOP prevents both read lanes from claiming work; diagnostics do not run queued blocks',async t=>{
 const {e,store,calls}=await fixture(t);await e.job('head:100','BLOCK',{height:100});await e.job('head:99','BLOCK',{height:99,history:true});
 await store.set('copy_config',{...await store.setting('copy_config'),enabled:false});assert.equal(await blockWork(e,false),false);assert.equal(await blockWork(e,true),false);assert.equal(await e.work({diagnosticOnly:true}),false);assert.deepEqual(calls,[]);
});
test('current target decode precedes historic decode, preserving source tx order within the block',async t=>{
 const {e}=await fixture(t);e.blockLanes=true;const seen=[];e.ingest=async p=>seen.push(p.hash);
 await e.job('old','TARGET',{hash:'old',history:true,block_number:90});await e.job('second','TARGET',{hash:'second',block_number:100,tx_index:11});await e.job('first','TARGET',{hash:'first',block_number:100,tx_index:2});
 await e.work();await e.work();await e.work({archiveOnly:true});assert.deepEqual(seen,['first','second','old']);
});
test('copy timestamps include hour, minute, second and millisecond, not only fractional seconds',()=>{
 const value=copyTime(new Date(2026,8,10,3,17,5,600).getTime());assert.match(value,/03:17:05[.,]600/);assert.equal(copyTime(null),'—');
});

test('an expired legacy observed block is recovered as history and never promoted to a current signal',async t=>{
 const {e,store}=await fixture(t);e.rpc.call=async()=>({number:'0x64',hash:h(100),parentHash:h(99),timestamp:'0x1',transactions:[{from:TARGET,hash}]});
 await e.block({height:100,method:'HTTP_FALLBACK',history:false,received_at:Date.now()});
 const p=decode((await store.get("SELECT payload FROM copy_jobs WHERE kind='TARGET'")).payload);
 assert.equal(p.history,true);assert.equal(p.history_reason,'EXPIRED_AT_BLOCK_READ');assert.equal(p.block.transactions,undefined);
});
test('old non-historical target backlog does not take precedence over a newly received event',async t=>{
 const {e}=await fixture(t);e.blockLanes=true;const seen=[];e.ingest=async p=>seen.push(p.hash);
 await e.job('legacy','TARGET',{hash:'legacy',target:TARGET,history:false,received_at:Date.now()-60000});await e.job('fresh','TARGET',{hash:'fresh',target:TARGET,history:false,received_at:Date.now()});
 await e.work();assert.deepEqual(seen,['fresh']);
});

test('historical decoder waiting on a provider does not delay the live target decoder',async t=>{
 const {e}=await fixture(t);e.blockLanes=true;const seen=[];let release,started;const entered=new Promise(resolve=>started=resolve);
 e.ingest=async p=>{if(p.hash==='old'){assert.equal(p.history,true);started();await new Promise(resolve=>release=resolve);}seen.push(p.hash);};
 await e.job('old','TARGET',{hash:'old',target:TARGET,history:true});const history=e.work({archiveOnly:true});await entered;
 await e.job('now','TARGET',{hash:'now',target:TARGET,received_at:Date.now()});await e.work();assert.deepEqual(seen,['now']);release();await history;assert.deepEqual(seen,['now','old']);
});
