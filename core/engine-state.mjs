import {fail,id,json} from './util.mjs';

export const engineSchema=`
CREATE TABLE IF NOT EXISTS engine_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,chain TEXT,entity_id TEXT,message TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS engine_events_time ON engine_events(at);
CREATE TABLE IF NOT EXISTS engine_jobs(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,locked_at INTEGER,owner TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT);
CREATE INDEX IF NOT EXISTS engine_jobs_ready ON engine_jobs(state,available_at);
CREATE TABLE IF NOT EXISTS chain_events(id TEXT PRIMARY KEY,chain TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT,block TEXT,address TEXT,received_at INTEGER NOT NULL,source TEXT NOT NULL,raw TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chain_events_time ON chain_events(received_at);
CREATE TABLE IF NOT EXISTS watched_wallets(wallet_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,head TEXT,catchup_before TEXT,catchup_head TEXT,last_sync INTEGER,last_event INTEGER,error TEXT);
CREATE TABLE IF NOT EXISTS trader_context(flow_id TEXT PRIMARY KEY,token_id TEXT NOT NULL,snapshot_id INTEGER,timing TEXT NOT NULL,captured_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS order_context(order_id TEXT PRIMARY KEY,signal_id TEXT,score REAL,reason TEXT,price REAL,market_cap REAL,slippage_bps REAL,realized_cents INTEGER);
CREATE TABLE IF NOT EXISTS ws_health(chain TEXT PRIMARY KEY,status TEXT NOT NULL,provider TEXT,last_event INTEGER,last_block TEXT,connected_at INTEGER,reconnects INTEGER DEFAULT 0,error TEXT,subscription_count INTEGER DEFAULT 0);
`;
export const engineDefaults={engine_desired:'STOPPED',engine_started_at:null,engine_heartbeat:null,entries_paused:false,engine_config:{scan_interval_ms:15000,wallet_interval_ms:30000,concurrency:3,max_tokens:12,retention_days:7},automation:{version_id:null,order_cents:200}};
export async function emit(store,kind,message,data={},chain=null,entity=null){
 await store.run('INSERT INTO engine_events(at,kind,chain,entity_id,message,data) VALUES (?,?,?,?,?,?)',Date.now(),kind,chain,entity,message,JSON.stringify(data));
}
export async function eventsAfter(store,after=0,limit=150){return (await store.all('SELECT * FROM engine_events WHERE id>? ORDER BY id LIMIT ?',Math.max(0,after),limit)).map(e=>({...e,data:json(e.data,{})}));}
export async function pauseEntries(store,paused=true){
 await store.set('entries_paused',paused);
 if(paused){await store.run("UPDATE orders SET state='CANCELLED',updated_at=? WHERE side='BUY' AND state IN ('CREATED','QUOTED','BUILT','SIMULATED','AWAITING_APPROVAL','APPROVED','SIGNED')",Date.now());await store.run("UPDATE reservations SET status='RELEASED' WHERE order_id IN (SELECT id FROM orders WHERE state='CANCELLED')");}
 await emit(store,'ENGINE',paused?'Entradas pausadas; las salidas siguen vigiladas':'Entradas habilitadas',{entries_paused:paused});
}
export async function controlEngine(store,action,options={}){
 fail(options.engineAvailable,'ENGINE_NOT_PROVISIONED: Instalá el motor en tu PC/VPS o conectá el servidor remoto.');
 if(action==='start'){
  await store.set('engine_enforced',true);
  const previous=await store.setting('engine_desired');
  await store.set('engine_desired','RUNNING');
  if(previous!=='RUNNING')await store.set('engine_started_at',Date.now());
  await emit(store,'ENGINE','Inicio del motor solicitado');
 }else if(action==='pause')await pauseEntries(store,true);
 else if(action==='resume')await pauseEntries(store,false);
 else if(action==='stop'||action==='emergency'){
  await store.set('engine_desired','STOPPED');await pauseEntries(store,true);
  if(action==='emergency')await store.stop();
  else{
   await store.set('epoch',(await store.setting('epoch'))+1);
   await store.run("UPDATE orders SET state='CANCELLED',updated_at=? WHERE state IN ('CREATED','QUOTED','BUILT','SIMULATED','AWAITING_APPROVAL','APPROVED','SIGNED')",Date.now());
   await store.run("UPDATE reservations SET status='RELEASED' WHERE order_id IN (SELECT id FROM orders WHERE state='CANCELLED')");
  }
  await emit(store,'ENGINE',action==='emergency'?'EMERGENCY STOP: trading detenido':'Motor detenido; posiciones conservadas, sin salidas automáticas');
 }else throw Error('UNKNOWN_ENGINE_ACTION');
 return {action,desired:await store.setting('engine_desired')};
}
export async function recoverEngine(store,owner){
 // Only the process holding the engine lease may recover jobs and scanner work.
 await store.run("UPDATE engine_jobs SET state='QUEUED',owner=NULL,locked_at=NULL,available_at=?,updated_at=? WHERE state='RUNNING' OR (state='FAILED' AND type IN ('WALLET_TX','SOLANA_POOL','EVM_POOL','SOLANA_CATCHUP'))",Date.now(),Date.now());
 await store.run("DELETE FROM settings WHERE key IN ('scanner_lease','training_lease','training_capture_lease')");
 await store.set('epoch',(await store.setting('epoch'))+1);
 await store.run("UPDATE orders SET state='CANCELLED',error='Cancelled before broadcast during recovery',updated_at=? WHERE state IN ('CREATED','QUOTED','BUILT','SIMULATED','AWAITING_APPROVAL','APPROVED','SIGNED')",Date.now());
 await store.run("UPDATE reservations SET status='RELEASED' WHERE order_id IN (SELECT id FROM orders WHERE state='CANCELLED')");
 if(String(await store.setting('mode')).startsWith('LIVE'))await pauseEntries(store,true);
 await emit(store,'RECOVERY','Estado recuperado: posiciones, sesiones y trabajos pendientes',{boot_id:owner});
}
export async function enqueue(store,key,type,payload={},delay=0,repeat=false){
 const now=Date.now();const r=await store.run(`INSERT INTO engine_jobs(id,type,payload,state,available_at,created_at,updated_at) VALUES (?,?,?,'QUEUED',?,?,?) ON CONFLICT(id) DO UPDATE SET state='QUEUED',payload=excluded.payload,attempts=0,available_at=excluded.available_at,updated_at=excluded.updated_at,error=NULL WHERE engine_jobs.state IN ('DONE','FAILED') AND ?=1`,key,type,JSON.stringify(payload),now+delay,now,now,repeat?1:0);return r.changes===1;
}
export async function claimJob(store,owner,types=null){
 const now=Date.now();const filter=types?.length?' AND type IN ('+types.map(()=>'?').join(',')+')':'';
 const row=await store.get("SELECT id FROM engine_jobs WHERE state='QUEUED' AND available_at<=?"+filter+" ORDER BY CASE type WHEN 'RECONCILE' THEN 0 WHEN 'PAPER_EXITS' THEN 1 WHEN 'SCAN' THEN 2 WHEN 'TRAINING_MARKET' THEN 3 WHEN 'WALLET_TX' THEN 4 ELSE 5 END,available_at LIMIT 1",now,...(types??[]));if(!row)return null;
 const r=await store.run("UPDATE engine_jobs SET state='RUNNING',owner=?,locked_at=?,updated_at=?,attempts=attempts+1 WHERE id=? AND state='QUEUED'",owner,now,now,row.id);if(!r.changes)return null;
 const job=await store.get('SELECT * FROM engine_jobs WHERE id=?',row.id);return {...job,payload:json(job.payload,{})};
}
export async function engineSummary(store,available){
 const heartbeat=await store.setting('engine_heartbeat'),desired=await store.setting('engine_desired')??'STOPPED';
 const fresh=heartbeat&&Date.now()-heartbeat.at<15000;
 const engineState=!available?'NOT_PROVISIONED':desired==='RUNNING'?(fresh?heartbeat.state:'OFFLINE'):'STOPPED';
 const counts=await store.get("SELECT (SELECT COUNT(*) FROM tokens) tokens,(SELECT COUNT(*) FROM tokens WHERE first_seen>?) tokens_min,(SELECT COUNT(*) FROM pools) pools,(SELECT COUNT(*) FROM wallet_flows) wallet_events,(SELECT COUNT(*) FROM signals WHERE decision='SIGNAL') signals,(SELECT COUNT(*) FROM orders WHERE state IN ('PAPER_FILLED','RECONCILED')) trades",Date.now()-60000);
 const jobs=await store.all('SELECT state,COUNT(*) count FROM engine_jobs GROUP BY state');
 return {available,state:engineState,desired,entries_paused:!!await store.setting('entries_paused'),started_at:await store.setting('engine_started_at'),heartbeat,counts,jobs,networks:await store.all('SELECT * FROM ws_health'),config:await store.setting('engine_config')};
}
