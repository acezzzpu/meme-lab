import {addr,check,cleanError,decode,encode,hex} from '../../core/copy/common.mjs';

// Two independent read lanes; only the short SQLite commits are serialized.
// Execution/signing remains in CopyEngine.work(), with its existing fences.
export function runLoop(engine,work,idleMs){
 const loop={timer:null,busy:false};engine.loops.add(loop);
 const step=async()=>{if(engine.closed)return;loop.busy=true;let worked=false;
  try{worked=await work();}catch(e){await engine.report('ERROR',cleanError(e)).catch(()=>{});}
  finally{loop.busy=false;if(!engine.closed)loop.timer=setTimeout(step,worked?0:idleMs);}
 };loop.timer=setTimeout(step,0);
}

export async function observeHead(e,o){
 const height=Number(BigInt(o.event.number)),hash=o.event.hash??null;
 check(Number.isSafeInteger(height)&&height>0,'INVALID_BLOCK_HEIGHT');
 const pair=height+':'+(hash??'http');if(e.seenHeads.has(pair))return;
 // Mark seen only after durable enqueue: a failed write must remain retryable.
 const prior=await e.store.get('SELECT hash FROM copy_blocks WHERE number=?',height);
 await e.store.run("UPDATE settings SET value=?,updated_at=? WHERE key='copy_cursor' AND value='null'",encode(height-1),Date.now());
 await e.store.run("INSERT INTO settings VALUES ('copy_observed_head',?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(settings.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT),updated_at=excluded.updated_at",encode(height),Date.now());
 if(!prior||hash&&hash!==prior.hash){
  const id='head:'+height,existing=await e.store.get('SELECT payload,state FROM copy_jobs WHERE id=?',id);
  const expected=decode(existing?.payload).expected_hash;
  // A second explicit hash gets its own verification job, even during an RPC.
  let attached=false;
  if(hash&&existing&&!expected){const result=await e.store.run("UPDATE copy_jobs SET payload=json_set(payload,'$.expected_hash',?) WHERE id=? AND state='QUEUED'",hash,id);attached=result.changes===1;}
  const verify=hash&&(prior||existing&&hash!==expected&&!attached);
  await e.job(verify?id+':'+hash:id,'BLOCK',{height,expected_hash:hash,provider:o.provider,received_at:o.received_at,method:o.method});
 }
 e.seenHeads.set(pair,true);if(e.seenHeads.size>400)e.seenHeads.delete(e.seenHeads.keys().next().value);
 await e.sample('HEAD',null,null,o.provider,{block:height,provider_received_at:o.received_at,method:o.method});
}

export async function readBlock(e,p){
 const saved=await e.store.get('SELECT * FROM copy_blocks WHERE number=?',p.height);
 if(saved&&(!p.expected_hash||p.expected_hash===saved.hash))return {cached:true,...saved};
 const key=p.height;
 if(e.blockReads.has(key))return e.blockReads.get(key);
 const read=e.rpc.call('eth_getBlockByNumber',[hex(p.height),true]);e.blockReads.set(key,read);
 try{return await read;}catch(error){e.blockReads.delete(key);throw error;}
}

async function recoverGaps(e,head){
 const cursor=await e.store.setting('copy_cursor');if(cursor===null||head<=cursor)return;
 for(let n=cursor+1;n<=Math.min(head,cursor+32);n++){
  if(await e.store.get('SELECT number FROM copy_blocks WHERE number=?',n))continue;
  // Also recognize 0.3.0 aliases; do not duplicate an already scheduled read.
  const existing=await e.store.get("SELECT id,state,available_at FROM copy_jobs WHERE kind='BLOCK' AND json_extract(payload,'$.height')=? ORDER BY CASE state WHEN 'RUNNING' THEN 0 WHEN 'QUEUED' THEN 1 ELSE 2 END LIMIT 1",n);
  if(existing){if(['FAILED','DONE'].includes(existing.state))await e.store.run("UPDATE copy_jobs SET state='QUEUED' WHERE id=? AND state IN ('FAILED','DONE')",existing.id);continue;}
  await e.job('head:'+n,'BLOCK',{height:n,received_at:Date.now(),method:'RECOVERY',history:true});
 }
}

export async function commitBlock(e,p,b){
 check(b,'BLOCK_NOT_AVAILABLE');
 if(!b.cached){
  check(Number(BigInt(b.number))===p.height&&typeof b.hash==='string'&&typeof b.parentHash==='string'&&Array.isArray(b.transactions),'INVALID_BLOCK_RESPONSE');
  const prior=await e.store.get('SELECT * FROM copy_blocks WHERE number=?',p.height);
  const parent=await e.store.get('SELECT * FROM copy_blocks WHERE number=?',p.height-1);
  const child=await e.store.get('SELECT * FROM copy_blocks WHERE number=?',p.height+1);
  if(p.expected_hash&&p.expected_hash!==b.hash||prior&&prior.hash!==b.hash||parent&&parent.hash!==b.parentHash||child&&child.parent_hash!==b.hash){
   await e.reorg(parent&&parent.hash!==b.parentHash?p.height-1:p.height,'BLOCK_HASH_CHANGED');return;
  }
  const header={number:b.number,hash:b.hash,parentHash:b.parentHash,timestamp:b.timestamp};
  const statements=[];
  for(const tx of b.transactions){if(typeof tx==='string')continue;const target=e.targets.find(t=>t.address===addr(tx.from));if(!target)continue;
   const targetAt=Number(BigInt(b.timestamp))*1000,expired=Date.now()-targetAt>(decode(target.config).max_signal_age_ms??2000);
   const payload={target:target.id,hash:tx.hash,tx,block:header,provider:p.provider,received_at:p.received_at,method:p.method,history:!!p.history||expired,history_reason:p.history?'RECOVERY':expired?'EXPIRED_AT_BLOCK_READ':null,target_at:targetAt,block_number:p.height,tx_index:Number(BigInt(tx.transactionIndex??0))};
   statements.push(["INSERT OR IGNORE INTO copy_jobs VALUES (?,?,'QUEUED',?,?,0,NULL)",['tx:'+target.id+':'+tx.hash,'TARGET',encode(payload),Date.now()]]);
  }
  // The block is complete iff all of its target jobs were committed atomically.
  statements.push(['INSERT OR IGNORE INTO copy_blocks VALUES (?,?,?,?)',[p.height,b.hash,b.parentHash,Date.now()]]);
  await e.store.batch(statements);
 }
 const cursor=await e.store.setting('copy_cursor');let advanced=cursor===null?p.height:cursor;
 while(await e.store.get('SELECT number FROM copy_blocks WHERE number=?',advanced+1))advanced++;
 if(advanced!==cursor)await e.store.set('copy_cursor',advanced);
 // Retire legacy aliases only for this exact hash. Contradicting hashes survive.
 await e.store.run("UPDATE copy_jobs SET state='DONE',error=NULL WHERE kind='BLOCK' AND state='QUEUED' AND json_extract(payload,'$.height')=? AND (json_extract(payload,'$.expected_hash') IS NULL OR json_extract(payload,'$.expected_hash')=?) AND (id IN (?,?,?) OR json_extract(payload,'$.expected_hash')=?)",p.height,b.hash,'head:'+p.height,'head:'+p.height+':http','head:'+p.height+':'+b.hash,b.hash);
 const head=Math.max(p.height,await e.store.setting('copy_observed_head')??0,(await e.store.get('SELECT MAX(number) n FROM copy_blocks')).n??0);
 await recoverGaps(e,head);
}

export async function blockWork(e,recovery){
 if(e.closed||!e.rpc)return false;
 const config=await e.store.setting('copy_config');
 if(!config.enabled||await e.store.setting('engine_desired')!=='RUNNING'||await e.store.setting('copy_reconciliation_required'))return false;
 const filter=recovery?'':"AND json_extract(payload,'$.history') IS NOT 1";
 const order=recovery?"CASE WHEN json_extract(payload,'$.history')=1 THEN 0 ELSE 1 END,json_extract(payload,'$.height') ASC":"json_extract(payload,'$.height') DESC";
 const job=await e.store.get(`SELECT * FROM copy_jobs WHERE kind='BLOCK' AND state='QUEUED' AND available_at<=? ${filter} ORDER BY ${order},available_at LIMIT 1`,Date.now());
 if(!job)return false;
 const claimed=await e.store.run("UPDATE copy_jobs SET state='RUNNING',attempts=attempts+1 WHERE id=? AND state='QUEUED'",job.id);if(!claimed.changes)return false;
 const p=decode(job.payload),legacyHash=job.id.split(':')[2];if(!p.expected_hash&&/^0x[\da-fA-F]{64}$/.test(legacyHash??''))p.expected_hash=legacyHash;
 try{await e.block(p);await e.store.run("UPDATE copy_jobs SET state='DONE',error=NULL WHERE id=?",job.id);}
 catch(error){await e.failJob(job,error);}return true;
}

export async function writeHeartbeat(e){
 const c=await e.store.setting('copy_config'),health=(await e.store.all('SELECT * FROM copy_provider_health')).map(h=>({...h,data:decode(h.data)}));
 const seen=[await e.store.setting('copy_observed_head'),...health.map(h=>h.data.block)].filter(n=>Number.isSafeInteger(n)&&n>0);
 const head=seen.length?Math.max(...seen):null,cursor=await e.store.setting('copy_cursor');
 const latest=await e.store.get('SELECT number,at FROM copy_blocks ORDER BY number DESC LIMIT 1');
 const lag=head!==null&&cursor!==null?Math.max(0,head-cursor):null;
 const scanned=lag===null?0:(await e.store.get('SELECT COUNT(*) n FROM copy_blocks WHERE number>? AND number<=?',cursor,head)).n;
 const queue=await e.store.all("SELECT kind,state,COUNT(*) n FROM copy_jobs WHERE state IN ('QUEUED','RUNNING','FAILED') GROUP BY kind,state");
 const connected=health.some(h=>['CONNECTED','RPC_ONLY'].includes(h.status)&&Date.now()-h.updated_at<15000);
 const active=c.enabled&&await e.store.setting('engine_desired')==='RUNNING';
 const headLag=head!==null&&latest?Math.max(0,head-latest.number):null;
 const staleRead=!latest||Date.now()-latest.at>15000;
 const status=await e.store.setting('copy_reconciliation_required')?'RECONCILIATION_REQUIRED':!active?'STOPPED':!connected?'CONNECTING':staleRead?'DATA_STALE':headLag>3?'LAGGING':lag>3?'RECOVERING':'WATCHING';
 await e.store.set('copy_runtime',{status,version:'0.4.1',at:Date.now(),boot_at:e.boot,uptime_ms:Date.now()-e.boot,cursor,observed_head:head,latest_scanned_block:latest?.number??null,last_scanned_at:latest?.at??null,block_lag:lag,head_lag:headLag,missing_blocks:lag===null?null:Math.max(0,lag-scanned),queue,pending_jobs:queue.filter(q=>q.state==='QUEUED').reduce((n,q)=>n+q.n,0),rpc_budget:e.rpc?.status?.()??[],last_rpc:e.rpc?.metrics.slice(-16)??[]});
 if(c.execution_wallet&&!e.walletBusy&&Date.now()-(e.lastWallet??0)>10000){e.walletBusy=true;e.lastWallet=Date.now();e.wallet().catch(error=>e.report('WALLET',cleanError(error))).finally(()=>e.walletBusy=false);}
}
