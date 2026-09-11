import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {blockWork} from '../runtime/copy/block-worker.mjs';
import {decode} from '../core/copy/common.mjs';
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const block=n=>({number:'0x'+n.toString(16),hash:hash(n),parentHash:hash(n-1),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[]});
async function fixture(t){const db=sqliteDriver(':memory:'),store=new Store(db,{encryptionKey:Buffer.alloc(32,12).toString('base64')});await store.init();t.after(()=>db.close());const e=new CopyEngine(store,{enableHistoryWorker:true});e.targets=await store.all('SELECT * FROM copy_targets');e.rpc={providers:[{history_dedicated:true}],metrics:[],call:async(_,[tag])=>block(Number(BigInt(tag)))};await store.set('copy_config',{...await store.setting('copy_config'),enabled:true});await store.set('engine_desired','RUNNING');return {e,store};}
test('legacy failed BLOCK jobs must not permanently suppress gap recovery',async t=>{
 const {e,store}=await fixture(t);await store.set('copy_cursor',100);e.liveWindow={from_block:101};await store.set('copy_live_cursor',100);
 await e.job('head:101','BLOCK',{height:101,history:true,method:'RECOVERY'});await store.run("UPDATE copy_jobs SET state='FAILED',attempts=6,error='legacy timeout' WHERE id='head:101'");
 await e.block({height:102,method:'HTTP_FALLBACK',received_at:Date.now()});
 const row=await store.get("SELECT state FROM copy_jobs WHERE id='head:101'");assert.equal(row.state,'QUEUED');
});
test('a completing legacy alias must preserve a newly queued contradicting canonical hash',async t=>{
 const {e,store}=await fixture(t);await store.set('copy_cursor',99);
 await e.job('head:100:http','BLOCK',{height:100,method:'HTTP_FALLBACK',received_at:Date.now()});await store.run("UPDATE copy_jobs SET state='RUNNING' WHERE id='head:100:http'");
 // A fresh websocket notification arrives during the legacy HTTP RPC.
 await e.observe({kind:'head',provider:'wss',method:'WEBSOCKET',received_at:Date.now(),event:{number:'0x64',hash:hash(100000)}});
 assert.equal(decode((await store.get("SELECT payload FROM copy_jobs WHERE id='head:100'")).payload).expected_hash,hash(100000));
 await e.block({height:100,method:'HTTP_FALLBACK',received_at:Date.now()});
 assert.equal((await store.get("SELECT state FROM copy_jobs WHERE id='head:100'")).state,'QUEUED');
});
test('fresh block lane commits while an independent recovery RPC remains unresolved',async t=>{
 const {e,store}=await fixture(t);await store.set('copy_cursor',100);
 let resolveHistory,started;const startedPromise=new Promise(r=>started=r);const gate=new Promise(r=>resolveHistory=r);
 e.rpc.call=async(_,[tag])=>{const n=Number(BigInt(tag));if(n===101){started();await gate;}return block(n);};
 await e.job('head:101','BLOCK',{height:101,history:true,method:'RECOVERY'});const recovery=blockWork(e,true);await startedPromise;
 await e.observe({kind:'head',provider:'http',method:'HTTP_FALLBACK',received_at:Date.now(),event:{number:'0x12c'}});
 await blockWork(e,false);assert.ok(await store.get('SELECT number FROM copy_blocks WHERE number=300'));assert.equal(await store.setting('copy_cursor'),100);
 resolveHistory();await recovery;assert.equal(await store.setting('copy_cursor'),101);
});
test('executor leaves BLOCK claims exclusively to the read lanes once enabled',async t=>{
 const {e,store}=await fixture(t);e.blockLanes=true;await e.job('head:100','BLOCK',{height:100,method:'HTTP_FALLBACK',received_at:Date.now()});
 assert.equal(await e.work(),false);assert.equal((await store.get("SELECT state FROM copy_jobs WHERE id='head:100'")).state,'QUEUED');
});
