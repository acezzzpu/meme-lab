import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {enqueue,claimJob,recoverEngine} from '../core/engine-state.mjs';
import {NetworkStream} from '../runtime/network-streams.mjs';
import {pollWallet} from '../core/watchers.mjs';
import {SolanaAdapter} from '../core/providers/chains.mjs';

async function memory(t){const db=sqliteDriver(':memory:');t.after(()=>db.close());const s=new Store(db);await s.init();return s;}
async function complete(s,id){await s.run("UPDATE engine_jobs SET state='DONE',owner=NULL WHERE id=?",id);}

test('a busy wallet cannot monopolize an accumulated queue, including equal timestamps',async t=>{
 const s=await memory(t);t.mock.method(Date,'now',()=>1789073294646);
 for(let i=0;i<40;i++)await enqueue(s,'a-'+i,'WALLET_TX',{wallet_id:'a'});
 for(const w of ['b','c'])for(let i=0;i<3;i++)await enqueue(s,w+'-'+i,'WALLET_TX',{wallet_id:w});
 const claimed=[];for(let i=0;i<6;i++){const job=await claimJob(s,'worker',['WALLET_TX']);claimed.push(job.payload.wallet_id);await complete(s,job.id);}
 assert.deepEqual(claimed,['a','b','c','a','b','c']);
 assert.equal((await s.get('SELECT COUNT(*) n FROM engine_jobs')).n,46);
});

test('fresh WebSocket and RPC observations are read before historical entries for the same wallet',async t=>{
 const s=await memory(t),now=Date.now();
 await enqueue(s,'a-history','WALLET_TX',{wallet_id:'wallet'});
 await enqueue(s,'b-old-rpc','WALLET_TX',{wallet_id:'wallet',source:'RPC',observed_at:now,occurred_at:now-3600000});
 await enqueue(s,'c-websocket','WALLET_TX',{wallet_id:'wallet',source:'WEBSOCKET',observed_at:now});
 await enqueue(s,'d-recent-rpc','WALLET_TX',{wallet_id:'wallet',source:'RPC',observed_at:now,occurred_at:now-5000});
 assert.equal((await claimJob(s,'worker',['WALLET_TX'])).id,'c-websocket');
 assert.equal((await claimJob(s,'worker',['WALLET_TX'])).id,'d-recent-rpc');
});

test('recent traffic from one wallet does not starve another wallet history',async t=>{
 const s=await memory(t),now=Date.now();
 for(let i=0;i<5;i++)await enqueue(s,'a-'+i,'WALLET_TX',{wallet_id:'a',source:'WEBSOCKET',observed_at:now});
 await enqueue(s,'z-b','WALLET_TX',{wallet_id:'b'});
 assert.equal((await claimJob(s,'worker',['WALLET_TX'])).payload.wallet_id,'a');
 assert.equal((await claimJob(s,'worker',['WALLET_TX'])).payload.wallet_id,'b');
});

test('recovery retains wallet turns and cannot make an old WebSocket observation fresh again',async t=>{
 const s=await memory(t);let now=1789073294646;t.mock.method(Date,'now',()=>now);
 await enqueue(s,'a-history','WALLET_TX',{wallet_id:'a'});
 await enqueue(s,'z-ws','WALLET_TX',{wallet_id:'a',source:'WEBSOCKET',observed_at:now});
 const first=await claimJob(s,'old-worker',['WALLET_TX']);assert.equal(first.id,'z-ws');
 await enqueue(s,'other','WALLET_TX',{wallet_id:'b'});
 now+=180001;await recoverEngine(s,'new-worker');
 assert.equal((await claimJob(s,'new-worker',['WALLET_TX'])).id,'other');
 assert.equal((await claimJob(s,'new-worker',['WALLET_TX'])).id,'a-history');
});

test('future timestamps and delayed retries do not bypass available_at or gain fresh priority',async t=>{
 const s=await memory(t),now=Date.now();
 await enqueue(s,'a-history','WALLET_TX',{wallet_id:'a'});
 await enqueue(s,'b-future','WALLET_TX',{wallet_id:'a',source:'WEBSOCKET',observed_at:now+3600000});
 await enqueue(s,'c-delayed','WALLET_TX',{wallet_id:'b',source:'WEBSOCKET',observed_at:now},60000);
 assert.equal((await claimJob(s,'worker',['WALLET_TX'])).id,'a-history');
 assert.equal((await s.get("SELECT state FROM engine_jobs WHERE id='c-delayed'")).state,'QUEUED');
});

test('live WebSocket metadata survives duplicate observations and remains observation evidence only',async t=>{
 const s=await memory(t);let now=1789073294646;t.mock.method(Date,'now',()=>now);
 const stream=new NetworkStream(s,{id:'solana',family:'solana'},[],'wss://solana-rpc.publicnode.com','');
 stream.subscriptions.set('wallet',{kind:'wallet',wallet_id:'a'});
 const msg=Buffer.from(JSON.stringify({params:{subscription:'wallet',result:{value:{signature:'sig',err:null}}}}));
 await stream.message(msg);now+=1000;await stream.message(msg);
 const row=await s.get("SELECT payload FROM engine_jobs WHERE type='WALLET_TX'");const p=JSON.parse(row.payload);
 assert.equal(p.source,'WEBSOCKET');assert.equal(p.observed_at,now-1000);
 assert.equal((await s.get("SELECT COUNT(*) n FROM engine_jobs WHERE type='WALLET_TX'")).n,1);
 assert.equal((await s.get('SELECT COUNT(*) n FROM learning_samples')).n,0);
 assert.equal((await s.get('SELECT COUNT(*) n FROM orders')).n,0);
});

test('polling uses actual RPC blockTime so downloading old signatures does not mark them recent',async t=>{
 const s=await memory(t),now=Date.now();
 await s.run("INSERT INTO wallets(id,chain,address,label,created_at) VALUES ('a','solana','owner','Fixture',?)",now);
 await s.run("INSERT INTO watched_wallets(wallet_id) VALUES ('a')");
 t.mock.method(SolanaAdapter.prototype,'rpc',async()=>[{signature:'sig',blockTime:Math.floor(now/1000)-3600}]);
 await pollWallet(s,'a');const row=await s.get("SELECT payload FROM engine_jobs WHERE type='WALLET_TX'");const p=JSON.parse(row.payload);
 assert.equal(p.source,'RPC');assert.equal(p.occurred_at,(Math.floor(now/1000)-3600)*1000);assert.ok(p.observed_at>=now);
});
