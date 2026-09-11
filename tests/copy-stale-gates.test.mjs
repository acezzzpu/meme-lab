import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {runCopySelfTest} from '../runtime/copy/self-test.mjs';
async function fixture(t){const db=sqliteDriver(':memory:'),store=new Store(db);await store.init();t.after(()=>db.close());const e=new CopyEngine(store);e.blockLanes=true;const target=(await store.get('SELECT id FROM copy_targets')).id;return {e,store,target};}

test('an old deferred target cannot block the current live self-test',async t=>{
 const {e,store,target}=await fixture(t);await e.job('old','TARGET',{target,received_at:e.boot-10000,block_number:90});await e.job('self-test','SELF_TEST',{});
 const work=e.work.bind(e);let ran=false;e.work=async options=>{if(options.diagnosticOnly){ran=true;return true;}return work(options);};
 assert.equal(await e.work({observationsOnly:true}),true);assert.equal(ran,true);assert.equal((await store.get("SELECT state FROM copy_jobs WHERE id='old'")).state,'QUEUED');
});

for(const stale of [true,false])test((stale?'old target backlog does not hold':'an earlier current target still holds')+' a later PAPER action',async t=>{
 const {e,store,target}=await fixture(t);await store.set('copy_live_cursor',110);
 await e.job('prior','TARGET',{target,received_at:stale?e.boot-10000:e.boot,block_number:90,tx_index:0});
 await store.run("INSERT INTO copy_actions(id,event_id,target_id,mode,side,token,state,epoch,created_at,updated_at,data) VALUES ('action','event',?,'PAPER','BUY','token','DETECTED',0,?,?,?)",target,Date.now(),Date.now(),JSON.stringify({event:{block:110,tx_index:0,side:'BUY'}}));
 let processed=false;e.processAction=async()=>{processed=true;};await e.work({actionsOnly:true});assert.equal(processed,stale);
});

test('self-test reconciles persisted fills across a restart without counting them as new live fills',async t=>{
 const {e,store,target}=await fixture(t);e.rpc={providers:[]};
 await store.run("INSERT INTO copy_actions(id,event_id,target_id,mode,side,token,state,epoch,created_at,updated_at,data) VALUES ('old-fill','event',?,'PAPER','BUY','token','FILLED',0,?,?,?)",target,e.boot-10000,e.boot-10000,JSON.stringify({event:{history:false}}));
 await store.run("INSERT INTO copy_ledger VALUES ('ledger','old-fill','PAPER','-100','0','0',?)",e.boot-10000);
 const result=await runCopySelfTest(e),status=name=>result.checks.find(c=>c.name===name).status;
 assert.equal(status('POSITION_RECONCILIATION'),'PASS');assert.equal(status('PAPER_BUY'),'FAIL');assert.equal(status('TARGET_FILTER'),'FAIL');
});
