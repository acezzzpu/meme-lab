import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';

test('block recovery and live target lookup use indexed search with a large retained history',async t=>{
 const db=sqliteDriver(':memory:'),store=new Store(db);await store.init();t.after(()=>db.close());
 await store.run("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<40000) INSERT INTO copy_jobs SELECT 'head:'||x,'BLOCK','DONE',json_object('height',x),0,1,NULL FROM n");
 await store.run("INSERT INTO copy_jobs VALUES ('head:40001','BLOCK','QUEUED',json_object('height',40001),0,0,NULL)");
 const sql="SELECT id,state,available_at FROM copy_jobs WHERE kind='BLOCK' AND json_extract(payload,'$.height')=? ORDER BY CASE state WHEN 'RUNNING' THEN 0 WHEN 'QUEUED' THEN 1 ELSE 2 END LIMIT 1";
 assert.equal((await store.get(sql,40001)).id,'head:40001');
 const plan=await store.all('EXPLAIN QUERY PLAN '+sql,40001);assert.ok(plan.some(r=>r.detail.includes('SEARCH copy_jobs USING INDEX copy_jobs_block_height')));assert.ok(!plan.some(r=>r.detail==='SCAN copy_jobs'));
 const live=await store.all("EXPLAIN QUERY PLAN SELECT id FROM copy_jobs WHERE kind='TARGET' AND state='QUEUED' AND available_at<=? LIMIT 1",Date.now());assert.ok(live.some(r=>r.detail.includes('copy_jobs_kind_ready')));
});
