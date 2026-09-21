import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {copySchema} from '../core/copy/schema.mjs';

const select=source=>`SELECT * FROM ${source} WHERE kind='BLOCK' AND state='QUEUED' AND available_at<=? AND json_extract(payload,'$.history') IS NOT 1 AND COALESCE(json_extract(payload,'$.received_at'),0)>=? ORDER BY json_extract(payload,'$.height') ASC,available_at LIMIT 1`;
test('large restart backlog preserves retry, boot, history and canonical ordering without sorting the backlog',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(copySchema);
 const insert=db.prepare('INSERT INTO copy_jobs VALUES (?,?,?,?,?,0,NULL)');
 const add=(id,height,available,state='QUEUED',extra={})=>insert.run(id,'BLOCK',state,JSON.stringify({height,received_at:101,history:false,...extra}),available);
 db.exec('BEGIN');for(let n=10000;n>0;n--)add('head:'+n,n,50+n);db.exec('COMMIT');
 add('retry',0,200000);add('old-boot',-1,1,'QUEUED',{received_at:99});
 add('history',-2,1,'QUEUED',{history:true});add('no-clock',-3,1,'QUEUED',{received_at:null});
 add('running',-4,1,'RUNNING');add('done',-5,1,'DONE');
 add('hash-alias',1,50,'QUEUED',{expected_hash:'0x'+'f'.repeat(64)});
 for(const now of [1000,300000]){
  const legacy=db.prepare(select('copy_jobs')).get(now,100);
  const indexed=db.prepare(select('copy_jobs INDEXED BY copy_jobs_block_live_ready')).get(now,100);
  assert.deepEqual(indexed,legacy);assert.equal(indexed.id,now===1000?'hash-alias':'retry');
 }
 const plan=db.prepare('EXPLAIN QUERY PLAN '+select('copy_jobs INDEXED BY copy_jobs_block_live_ready')).all(1000,100);
 assert.ok(plan.some(p=>p.detail.includes('copy_jobs_block_live_ready')));
 assert.ok(!plan.some(p=>p.detail.includes('TEMP B-TREE')));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM copy_jobs').get().n,10007);
});
