import {gunzipSync} from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {decodeEconomicTarget} from '../runtime/copy/economic-decoder.mjs';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {decode} from '../core/copy/common.mjs';
import {account} from '../core/copy/service.mjs';
import {pendingIntent} from '../runtime/copy/pending-intent.mjs';
const directory=new URL('./fixtures/bnb-target-20260910/',import.meta.url);
const fixture=JSON.parse(gunzipSync(Buffer.from(await fs.readFile(new URL('sample.json.gz.b64',directory),'utf8'),'base64'))),cache=JSON.parse(await fs.readFile(new URL('rpc.json',directory)));
const audit=JSON.parse(await fs.readFile(new URL('native-audit.json',directory)));
const methods=[];
const rpc={call:async(method,params=[])=>{methods.push(method);const key=JSON.stringify([method,params]);if(Object.hasOwn(cache,key))return cache[key];throw Error('REAL_FIXTURE_RESPONSE_NOT_CAPTURED: '+key);},contract:async(to,abi,method,args=[],block='latest')=>abi.decodeFunctionResult(method,await rpc.call('eth_call',[{to,data:abi.encodeFunctionData(method,args)},block]))};

test('provisional custom-router calldata matches side/token/input for all 36 real confirmed trades; no receipt is claimed',()=>{
 const trades=fixture.samples.filter(s=>s.expected.side);assert.equal(trades.length,36);
 for(const s of trades){const p=pendingIntent(s.tx,fixture.provenance.target);assert.equal(p.side,s.expected.side,s.tx.hash);assert.equal(p.token,s.expected.token);assert.equal(p.target_input_raw,s.expected.side==='BUY'?s.expected.quote_raw:s.expected.quantity_raw);assert.equal(p.confirmed,false);assert.equal(p.status,'PROVISIONAL');}
});

test('50 real consecutive outgoing transactions retain classification, token, amount and sell inventory without tracing',async()=>{
 const nonces=fixture.samples.map(s=>Number(BigInt(s.tx.nonce)));
 assert.equal(nonces.length,50);assert.deepEqual(nonces,Array.from({length:50},(_,i)=>fixture.provenance.first_nonce+i));
 const counts={};
 for(const s of fixture.samples){
  const d=await decodeEconomicTarget(rpc,s.tx,s.receipt,s.block,fixture.provenance.target,{enrichMetadata:true,historical:true});
  for(const key of ['kind','side','token','quantity_raw','quote_raw','target_balance_before'])assert.equal(d[key],s.expected[key],s.tx.hash+':'+key);
  counts[d.kind]=(counts[d.kind]??0)+1;
  if(s.expected.independently_audited_native_raw&&d.side==='SELL'){
   assert.ok(d.quote_estimate,'Gross unwrap must never be labelled exact target proceeds');
   const gross=BigInt(d.quote_raw),net=BigInt(s.expected.independently_audited_native_raw);
   assert.equal(gross-net,gross/100n,'Independent archive trace shows router fee of 1% in this sample');
  }
 }
 assert.deepEqual(counts,{APPROVAL:14,PARTIAL_SELL:12,BUY:22,SELL:2});
 assert.ok(!methods.some(m=>m.startsWith('debug_')));
 assert.equal(audit.count,20);assert.equal(audit.side_matches,20);
});

test('HISTORICAL REPLAY: real target receipts + explicitly synthetic unit-test quotes conserve our inventory, cash and PnL; not acceptance',async t=>{
 const db=sqliteDriver(':memory:'),store=new Store(db,{encryptionKey:Buffer.alloc(32,7).toString('base64')});await store.init();t.after(()=>db.close());
 await store.set('engine_desired','RUNNING');await store.set('copy_config',{...await store.setting('copy_config'),enabled:true,paper_capital_bnb:'1'});
 const e=new CopyEngine(store,{historicalReplay:true}),target=fixture.provenance.target;
 // Deliberate deterministic quote double tests accounting ONLY. Real market
 // replay uses scripts/replay-copy-paper.mjs; this cannot pass live self-test.
 e.routes={quote:async q=>({provider:'UNIT_TEST_ONLY',side:q.side,token:q.token,amount_raw:q.amount,out_raw:String(BigInt(q.amount)*2n),min_out_raw:String(BigInt(q.amount)*2n),fee_raw:'100',slippage_bps:100,quoted_at:Date.now(),tax_adjusted:false})};
 let bought=0,sold=0,duplicates=0;
 for(const s of fixture.samples){
  e.rpc={...rpc,call:async(m,p)=>m==='eth_getTransactionReceipt'?s.receipt:rpc.call(m,p)};
  await e.ingest({target,hash:s.tx.hash,tx:s.tx,block:s.block,history:true,method:'HISTORICAL_REPLAY'});
  await e.ingest({target,hash:s.tx.hash,tx:s.tx,block:s.block,history:true});duplicates++;
  const a=await store.get('SELECT * FROM copy_actions WHERE event_id=?',target+':'+s.tx.hash);if(a){await e.processAction(a);const after=await store.get('SELECT * FROM copy_actions WHERE id=?',a.id);if(after.state==='FILLED'){a.side==='BUY'?bought++:sold++;assert.equal(decode(after.data).paper_model.historical,true);}else assert.equal(after.error,'NO_COPIED_POSITION');}
 }
 assert.equal((await store.get('SELECT COUNT(*) n FROM copy_events')).n,50);assert.equal(duplicates,50);assert.equal(bought,22);assert.ok(sold>0);
 const positions=await store.all("SELECT * FROM copy_positions WHERE mode='PAPER'"),fills=(await store.all("SELECT * FROM copy_actions WHERE state='FILLED'")).map(a=>({...a,data:decode(a.data)}));
 for(const p of positions){const ours=fills.filter(a=>a.token===p.token);const expected=ours.reduce((n,a)=>n+(a.side==='BUY'?BigInt(a.data.fill.output_raw):-BigInt(a.data.fill.input_raw)),0n);assert.equal(BigInt(p.quantity_raw),expected);assert.ok(expected>=0n);}
 const ledger=await store.all('SELECT * FROM copy_ledger');assert.equal(ledger.length,bought+sold);
 const a=await account(store,'PAPER',await store.setting('copy_config'));assert.equal(a.cash,10n**18n+ledger.reduce((n,r)=>n+BigInt(r.delta_raw),0n));
 assert.equal((await store.get("SELECT COUNT(*) n FROM copy_samples WHERE kind='PAPER_REACTION_MS'")).n,0);
});

test('recovery repairs a confirmed real source whose PAPER action was not durably queued, without duplicating a subsequent fill',async t=>{
 const db=sqliteDriver(':memory:'),store=new Store(db,{encryptionKey:Buffer.alloc(32,7).toString('base64')});await store.init();t.after(()=>db.close());await store.set('copy_config',{...await store.setting('copy_config'),enabled:true});
 const sample=fixture.samples.find(s=>s.expected.side==='BUY'),target=fixture.provenance.target,e=new CopyEngine(store);
 e.rpc={...rpc,call:async(m,p)=>m==='eth_getTransactionReceipt'?sample.receipt:rpc.call(m,p)};
 const payload={target,hash:sample.tx.hash,tx:sample.tx,block:sample.block,method:'BLOCK'};await e.ingest(payload);
 const eventId=target+':'+sample.tx.hash;await store.run('DELETE FROM copy_actions WHERE event_id=?',eventId);
 await e.ingest(payload);await e.ingest(payload);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_actions WHERE event_id=?',eventId)).n,1);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_source_transactions')).n,1);
});
