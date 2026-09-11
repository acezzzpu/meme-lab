import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {measuredQuantiles,saveProfile,observationProfile,latencyProfileSummary} from '../core/copy/latency-profile.mjs';

test('latency percentiles require actual finite samples, including real zeros',()=>{
 assert.deepEqual(measuredQuantiles([null,undefined,NaN,-1]).insufficient_for,['P50','P95','P99']);
 assert.equal(measuredQuantiles([0]).p50_ms,null);assert.equal(measuredQuantiles([0,10]).p50_ms,0);
 const q=measuredQuantiles(Array.from({length:100},(_,i)=>i+1));assert.equal(q.p50_ms,50);assert.equal(q.p95_ms,95);assert.equal(q.p99_ms,99);
 assert.equal(measuredQuantiles([1,2,3]).p95_ms,null);
});
test('mempool source requires same boot pending message before the locally observed head',()=>{
 const e={boot:1,eventClocks:new Map()},p={target:'t',hash:'h',clock_boot:1,head_received_mono:100,received_mono:130},event={side:'BUY',token:'x'};
 let v=observationProfile(e,p,event,{clock_boot:1,pending_received_mono:80,pending_received_at:1000,provisional_decode_ms:2},{});
 assert.equal(v.detection_source,'PENDING_MEMPOOL');assert.equal(v.pending_advantage_ms,20);
 v=observationProfile(e,p,event,{clock_boot:1,pending_received_mono:110,pending_received_at:1000},{});assert.equal(v.detection_source,'BLOCK');assert.equal(v.pending_advantage_ms,null);
 v=observationProfile(e,p,event,{clock_boot:0,pending_received_mono:80,pending_received_at:1000},{});assert.equal(v.detection_source,'BLOCK');assert.equal(v.stages.PENDING_DETECTION,null);
});
test('profiles survive SQLite restart, merge stages once and never count historical replay as live',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bnb-profile-')),path=join(dir,'db.sqlite');let db=sqliteDriver(path);let store=new Store(db);await store.init();
 await saveProfile(store,'live',{version:1,side:'BUY',wall:{target_first_seen_at:100},stages:{DECODE:2}});
 await saveProfile(store,'live',{stages:{QUOTE:20},paper:{status:'FILLED'}});
 await saveProfile(store,'history',{version:1,side:'BUY',history:true,stages:{DECODE:1000}});db.close();
 db=sqliteDriver(path);store=new Store(db);await store.init();const out=await latencyProfileSummary(store);
 assert.equal(out.live_sample_count,1);assert.equal(out.stages.DECODE.n,1);assert.equal(out.stages.QUOTE.n,1);assert.equal(out.records.find(r=>r.paper).stages.DECODE,2);db.close();rmSync(dir,{recursive:true});
});
test('diagnostic persistence error cannot reject execution',async()=>{assert.equal(await saveProfile({run:async()=>{throw Error('disk error');}},'e',{stages:{DECODE:2}}),false);});
