import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {enqueue,claimJob,claimScheduledJob} from '../core/engine-state.mjs';

async function memory(t){const db=sqliteDriver(':memory:');t.after(()=>db.close());const store=new Store(db);await store.init();return store;}

test('training prices can use the reserved slot while two historical jobs are still running',async t=>{
 const store=await memory(t);
 for(const id of ['history-a','history-b']){await enqueue(store,id,'WALLET_TX');await claimJob(store,'busy');}
 await enqueue(store,'history-c','SOLANA_POOL');
 await enqueue(store,'training-market','TRAINING_MARKET');
 const job=await claimScheduledJob(store,'fresh-prices',['WALLET_TX','WALLET_TX'],3);
 assert.equal(job?.id,'training-market');
 assert.equal((await store.get("SELECT COUNT(*) n FROM engine_jobs WHERE state='RUNNING'")).n,3);
 assert.equal((await store.get("SELECT state FROM engine_jobs WHERE id='history-c'")).state,'QUEUED');
});

test('reconciliation and exits retain precedence over training and discovery',async t=>{
 const store=await memory(t);
 for(const [id,type] of [['scan','SCAN'],['training','TRAINING_MARKET'],['exit','PAPER_EXITS'],['reconcile','RECONCILE']])await enqueue(store,id,type);
 assert.equal((await claimScheduledJob(store,'one',['WALLET_TX','SOLANA_POOL'],3)).id,'reconcile');
 assert.equal((await claimScheduledJob(store,'two',['WALLET_TX','SOLANA_POOL'],3)).id,'exit');
 assert.equal((await claimScheduledJob(store,'three',['WALLET_TX','SOLANA_POOL'],3)).id,'training');
});

test('training price refresh precedes optional discovery even with only one worker slot',async t=>{
 const store=await memory(t);await enqueue(store,'scan','SCAN');await enqueue(store,'prices','TRAINING_MARKET');
 assert.equal((await claimScheduledJob(store,'one',[],1)).id,'prices');
});

test('wallet polling, health and fitting are not starved by transaction backfill',async t=>{
 const store=await memory(t);
 for(let i=0;i<20;i++)await enqueue(store,'history-'+i,'WALLET_TX');
 for(const type of ['WALLET_POLL','HEALTH','LEARNING'])await enqueue(store,type,type);
 const claimed=[];for(let i=0;i<3;i++)claimed.push((await claimScheduledJob(store,'foreground',[],3)).type);
 assert.deepEqual(new Set(claimed),new Set(['WALLET_POLL','HEALTH','LEARNING']));
 assert.equal((await claimScheduledJob(store,'background',[],3)).type,'WALLET_TX');
});

test('the reserved slot does not become another historical worker when no urgent job is due',async t=>{
 const store=await memory(t);await enqueue(store,'history','WALLET_TX');await enqueue(store,'later','TRAINING_MARKET',{},60000);
 assert.equal(await claimScheduledJob(store,'reserved',['WALLET_TX','SOLANA_POOL'],3),null);
 assert.equal((await claimScheduledJob(store,'background',[],3)).id,'history');
});

test('PAPER and LIVE retain the execution-only reserved slot even with training queued',async t=>{
 const store=await memory(t);await enqueue(store,'prices','TRAINING_MARKET');
 for(const mode of ['PAPER','LIVE_APPROVAL','LIVE_AUTO']){
  await store.set('mode',mode);
  assert.equal(await claimScheduledJob(store,'reserved',['WALLET_TX','SOLANA_POOL'],3),null);
 }
 await store.set('mode','OBSERVE');await store.set('trading_enabled',true);
 assert.equal(await claimScheduledJob(store,'reserved',['WALLET_TX','SOLANA_POOL'],3),null);
 await enqueue(store,'exit','PAPER_EXITS');
 assert.equal((await claimScheduledJob(store,'reserved',['WALLET_TX','SOLANA_POOL'],3)).id,'exit');
});

test('an active training refresh does not release the execution reservation to backfill',async t=>{
 const store=await memory(t);await enqueue(store,'history','WALLET_TX');
 assert.equal(await claimScheduledJob(store,'reserved',['TRAINING_MARKET','WALLET_TX'],3),null);
});
