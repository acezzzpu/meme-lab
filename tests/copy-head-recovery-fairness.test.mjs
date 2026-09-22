import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {blockWork} from '../runtime/copy/block-worker.mjs';
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
async function fixture(t){
 const driver=sqliteDriver(':memory:'),store=new Store(driver,{encryptionKey:Buffer.alloc(32,1).toString('base64')});await store.init();t.after(()=>driver.close());
 const e=new CopyEngine(store);e.targets=await store.all('SELECT * FROM copy_targets');
 await store.set('engine_desired','RUNNING');await store.set('copy_config',{...await store.setting('copy_config'),enabled:true});
 await store.set('copy_cursor',100);await store.set('copy_live_cursor',100);await store.set('copy_live_window',{boot:e.boot-20000,from_block:100,started_at:e.boot-20000});
 await store.run('INSERT INTO copy_blocks VALUES (?,?,?,?)',100,hash(100),hash(99),Date.now());
 const calls=[];e.rpc={providers:[],metrics:[],call:async(_,[tag])=>{const height=Number(BigInt(tag));calls.push(height);return {number:tag,hash:hash(height),parentHash:hash(height-1),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:height>=10000?[{hash:hash(height+100000),from:e.targets[0].address,to:'0x'+'a'.repeat(40),transactionIndex:'0x0'}]:[]};}};
 const head=n=>e.observe({kind:'head',provider:'test',method:'WEBSOCKET',received_at:Date.now(),event:{number:'0x'+n.toString(16),hash:hash(n)}});
 return {store,e,head,calls};
}
test('current HEAD capture and oldest gap both progress without skipping the execution cursor',async t=>{
 const {e,store,head,calls}=await fixture(t);await head(10000);
 await blockWork(e,false,true);assert.deepEqual(calls,[10000]);assert.equal(await store.setting('copy_live_cursor'),100);
 await blockWork(e,false);assert.deepEqual(calls,[10000,101]);assert.equal(await store.setting('copy_live_cursor'),101);
 await head(10001);await blockWork(e,false,true);assert.deepEqual(calls,[10000,101,10001]);assert.equal(await store.setting('copy_live_cursor'),101);
 const counts=async()=>Promise.all(['copy_positions','copy_ledger','copy_actions'].map(table=>store.get('SELECT COUNT(*) n FROM '+table)));
 assert.deepEqual((await counts()).map(r=>r.n),[0,0,0]);
 assert.equal((await store.get("SELECT COUNT(*) n FROM copy_jobs WHERE kind='TARGET'")).n,2);
 const target=e.targets[0].id;let executed=false;e.processAction=async()=>{executed=true;};
 await store.run("INSERT INTO copy_actions(id,event_id,target_id,mode,side,state,epoch,created_at,updated_at,data) VALUES ('future','future',?,'PAPER','BUY','DETECTED',0,1,1,?)",target,JSON.stringify({event:{block:10000,tx_index:0,history:false}}));
 assert.equal(await e.work({actionsOnly:true}),false);assert.equal(executed,false);
 // Repeated HEADs and an empty current-head queue reuse the gap lane safely.
 await head(10001);await blockWork(e,false,true);assert.deepEqual(calls,[10000,101,10001,102]);
 assert.equal((await store.get("SELECT COUNT(*) n FROM copy_jobs WHERE kind='TARGET'")).n,2);
});
test('a stalled live-gap RPC cannot hold the existing HEAD lane',async t=>{
 const {e,store,head}=await fixture(t);await head(10000);
 const original=e.rpc.call;let release,started;const start=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 e.rpc.call=async(method,args)=>{if(Number(BigInt(args[0]))===101){started();await wait;}return original(method,args);};
 const gap=blockWork(e,false);await start;await blockWork(e,false,true);
 assert.ok(await store.get('SELECT number FROM copy_blocks WHERE number=10000'));assert.equal(await store.setting('copy_live_cursor'),100);
 release();await gap;assert.equal(await store.setting('copy_live_cursor'),101);
});
test('HEAD preference preserves delayed retries and excludes historical or prior-boot work',async t=>{
 const {e,store,head,calls}=await fixture(t);await head(10000);
 await store.run("UPDATE copy_jobs SET available_at=? WHERE id='head:10000'",Date.now()+60000);
 await e.job('history:9999','BLOCK',{height:9999,received_at:Date.now(),history:true});
 await e.job('old:9998','BLOCK',{height:9998,received_at:e.boot-1,history:false});
 await blockWork(e,false,true);assert.deepEqual(calls,[101]);
 for(const id of ['head:10000','history:9999','old:9998'])assert.equal((await store.get('SELECT state FROM copy_jobs WHERE id=?',id)).state,'QUEUED');
});
