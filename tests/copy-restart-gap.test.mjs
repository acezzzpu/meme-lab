import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {blockWork} from '../runtime/copy/block-worker.mjs';
import {applyFill} from '../core/copy/execution-policy.mjs';
import {encode,decode} from '../core/copy/common.mjs';
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
async function fixture(t){
 const db=sqliteDriver(':memory:'),store=new Store(db,{encryptionKey:Buffer.alloc(32,12).toString('base64')});await store.init();t.after(()=>db.close());
 await store.set('engine_desired','RUNNING');await store.set('copy_config',{...await store.setting('copy_config'),enabled:true});
 const target=(await store.all('SELECT * FROM copy_targets'))[0],boot=Date.now(),calls=[];
 await store.run('INSERT INTO copy_blocks VALUES (?,?,?,?)',100,hash(100),hash(99),boot-20000);
 await store.set('copy_live_window',{boot:boot-20000,from_block:100,started_at:boot-20000});await store.set('copy_live_cursor',100);await store.set('copy_cursor',50);
 const e=new CopyEngine(store);e.boot=boot;e.targets=[target];e.rpc={providers:[],metrics:[],call:async(_,[tag])=>{const n=Number(BigInt(tag));calls.push(n);return {number:tag,hash:hash(n),parentHash:hash(n-1),timestamp:'0x'+Math.floor((boot-20000+(n-100)*450)/1000).toString(16),transactions:n===110?[{hash:hash(9000),from:target.address,to:'0x'+'a'.repeat(40),transactionIndex:'0x0'}]:[]};}};
 return {store,e,target,calls,boot};
}
const head=(e,n)=>e.observe({kind:'head',provider:'test',method:'WEBSOCKET',received_at:Date.now(),event:{number:'0x'+n.toString(16),hash:hash(n)}});
for(const gap of [34,44])test(`restart catches up ${gap} blocks (~15–20 seconds), bounded and idempotent`,async t=>{
 const {e,store,calls,boot}=await fixture(t);
 await e.job('head:110','BLOCK',{height:110,received_at:boot-20000,clock_boot:boot-20000,expected_hash:hash(110)});
 await head(e,100+gap);assert.equal(await store.setting('copy_live_cursor'),100);
 assert.ok((await store.all("SELECT id FROM copy_jobs WHERE kind='BLOCK'")).length<=33);
 for(let i=0;i<gap+5;i++)if(!await blockWork(e,false))break;
 assert.equal(await store.setting('copy_live_cursor'),100+gap);
 assert.equal((await store.all('SELECT * FROM copy_blocks WHERE number>100')).length,gap);
 assert.equal(calls.length,gap);assert.equal(new Set(calls).size,gap);
 let jobs=await store.all("SELECT * FROM copy_jobs WHERE kind='TARGET'");assert.equal(jobs.length,1);
 const payload=decode(jobs[0].payload);assert.equal(payload.history,false);assert.equal(payload.late,true);assert.equal(payload.late_reason,'EXPIRED_AT_BLOCK_READ');
 // A second process sees persisted blocks and must not schedule duplicate TXs.
 const next=new CopyEngine(store);next.boot=Date.now();next.targets=e.targets;next.rpc=e.rpc;
 await head(next,100+gap);for(let i=0;i<3;i++)await blockWork(next,false);
 jobs=await store.all("SELECT * FROM copy_jobs WHERE kind='TARGET'");assert.equal(jobs.length,1);assert.equal((await store.all('SELECT * FROM copy_source_transactions')).length,1);assert.equal(calls.length,gap);
});
test('block recovery cannot mutate existing actions, positions or ledger',async t=>{
 const {e,store,target}=await fixture(t),token='0x'+'b'.repeat(40),eventId=target.id+':'+hash(7),actionId=eventId+':PAPER';
 await store.run('INSERT INTO copy_events VALUES (?,?,?,?,?,?,?,?,?,?)',eventId,target.id,hash(7),100,hash(100),0,'BUY','CONFIRMED',Date.now(),encode({side:'BUY',token}));
 const action={id:actionId,event_id:eventId,target_id:target.id,mode:'PAPER',side:'BUY',token,state:'PROCESSING',epoch:0,data:'{}'};
 await store.run("INSERT INTO copy_actions(id,event_id,target_id,mode,side,token,state,epoch,created_at,updated_at,data) VALUES (?,?,?,?,?,?,'PROCESSING',0,?,?,?)",actionId,eventId,target.id,'PAPER','BUY',token,Date.now(),Date.now(),'{}');
 assert.equal(await applyFill(store,action,{inputRaw:'100',outputRaw:'1000',feeRaw:'2',markPrice:1}),true);
 const tables=['copy_events','copy_actions','copy_positions','copy_ledger','copy_target_positions'];const snapshot=()=>Promise.all(tables.map(x=>store.all('SELECT * FROM '+x)));
 const before=await snapshot();await head(e,144);for(let i=0;i<50;i++)if(!await blockWork(e,false))break;
 assert.deepEqual(await snapshot(),before);assert.equal((await store.setting('copy_config')).live_enabled,false);
});
