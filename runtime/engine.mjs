import {trainIfReady,refreshTrainingMarket} from '../core/learning/pipeline.mjs';
import {CopyEngine} from './copy/engine.mjs';
import {runtimeContext} from './context.mjs';
import {NetworkStreams} from './network-streams.mjs';
import {scanOnce} from '../core/scanner.mjs';
import {monitorPaperPositions,reconcileWithPrices} from '../core/position-monitor.mjs';
import {resolveOptions} from '../core/service.mjs';
import {ExecutionEngine} from '../core/execution/engine.mjs';
import {checkHealth,adapter,RH} from '../core/providers/chains.mjs';
import {pollWallet,ingestWalletTransaction,updateWatchedPatterns} from '../core/watchers.mjs';
import {inspectSolanaPool,inspectEvmPool} from '../core/pool-discovery.mjs';
import {recoverEngine,enqueue,claimJob,emit} from '../core/engine-state.mjs';
import {id,safeError,json} from '../core/util.mjs';

const {db,store,options}=await runtimeContext();const owner=id();let closing=false,ready=false,streamsActive=false,lastRefresh=0,lastMaintain=0,heartbeatBusy=false;
const active=new Map(),streams=new NetworkStreams(store,options);const copyEngine=new CopyEngine(store,options);let copyStarted=false;const bootAt=Date.now();let lastCompleted=null,lastError=null;
async function lease(){const now=Date.now();const r=await store.run("INSERT INTO settings VALUES ('engine_lease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE json_extract(settings.value,'$.until')<? OR json_extract(settings.value,'$.owner')=?",JSON.stringify({owner,until:now+15000}),now,now,owner);return r.changes===1;}
async function heartbeat(){if(heartbeatBusy||closing)return;heartbeatBusy=true;try{
 if(!await lease()){if(ready){await streams.stop();process.exit(2);}process.send?.({kind:'standby',at:Date.now()});return;}
 if(!ready){await recoverEngine(store,owner);ready=true;if(!copyStarted){copyStarted=true;await copyEngine.start();}}
 const desired=await store.setting('engine_desired');const stalled=[...active.values()].some(t=>Date.now()-t.at>120000);
 const state=desired==='RUNNING'?(stalled?'DEGRADED':'RUNNING'):(active.size?'STOPPING':'STOPPED');
 await store.set('engine_heartbeat',{at:Date.now(),boot_id:owner,pid:process.pid,boot_at:bootAt,state,last_completed_at:lastCompleted,last_error:lastError,active_jobs:[...active.values()].map(v=>({type:v.type,started_at:v.at})),process_uptime_seconds:Math.floor(process.uptime())});
 process.send?.({kind:'heartbeat',at:Date.now(),state,active:[...active.values()]});
}catch(e){lastError=safeError(e);}finally{heartbeatBusy=false;}}
async function recurring(key,type,payload,interval){const previous=await store.get('SELECT state,available_at FROM engine_jobs WHERE id=?',key);if(!previous||(['DONE','FAILED'].includes(previous.state)&&previous.available_at<=Date.now()))await enqueue(store,key,type,{...payload,interval_ms:interval},0,true);}
async function evmCatchup(chain){
 const a=adapter(chain),latest=parseInt(await a.rpc('eth_blockNumber'),16)-2;if(latest<0)return;
 const key='pool_cursor:'+chain.id,prior=await store.setting(key),from=prior===null?Math.max(0,latest-25):prior+1,to=Math.min(latest,from+999);if(from>to)return;
 const logs=await a.rpc('eth_getLogs',[{address:RH.factory,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:['0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9']}]);
 for(const log of logs)await enqueue(store,'pool:'+log.transactionHash+':'+log.logIndex,'EVM_POOL',{chain:chain.id,log});await store.set(key,to);
}
async function solanaCatchup(payload){
 const chain=await store.get("SELECT * FROM chains WHERE id='solana' AND enabled=1");if(!chain||!payload.until)return;
 const backlog=await store.get("SELECT COUNT(*) n FROM engine_jobs WHERE state IN ('QUEUED','RUNNING')");if(backlog.n>1000)throw Error('BACKFILL_WAITING_FOR_QUEUE');
 const rows=await adapter(chain).rpc('getSignaturesForAddress',[payload.program,{until:payload.until,...(payload.before?{before:payload.before}:{}),limit:50,commitment:'confirmed'}]);
 for(const row of rows)if(!row.err)await enqueue(store,'pool:'+row.signature,'SOLANA_POOL',{hash:row.signature});
 if(rows.length===50){const before=rows.at(-1).signature;await enqueue(store,'catchup:'+payload.program+':'+payload.until+':'+before,'SOLANA_CATCHUP',{...payload,before},3000);}
 await emit(store,'BACKFILL','Recuperación de logs Solana',{program:payload.program,transactions:rows.length,until:payload.until,before:payload.before??null},'solana');
}
async function work(job){
 const current=await resolveOptions(store,options);
 switch(job.type){
  case 'SCAN':return scanOnce(store,{...current,skipHealth:true,skipReconcile:true,skipExits:true});
  case 'HEALTH':{const chains=await store.all('SELECT * FROM chains WHERE enabled=1');for(const c of chains){const result=await checkHealth(store,c);if(result.status!=='CONNECTED')await emit(store,'ERROR','Conexión RPC con error',{...result,provider:new URL(c.rpc_url).hostname},c.id);}return;}
  case 'PAPER_EXITS':return monitorPaperPositions(store,current);
  case 'RECONCILE':return reconcileWithPrices(store,current);
  case 'WALLET_POLL':return pollWallet(store,job.payload.wallet_id);
  case 'WALLET_TX':return ingestWalletTransaction(store,job.payload.wallet_id,job.payload.hash);
  case 'LEARNING':await updateWatchedPatterns(store);return trainIfReady(store);
  case 'TRAINING':return trainIfReady(store);
  case 'TRAINING_MARKET':return refreshTrainingMarket(store);
  case 'SOLANA_CATCHUP':return solanaCatchup(job.payload);
  case 'SOLANA_POOL':return inspectSolanaPool(store,job.payload.hash);
  case 'EVM_POOL':return inspectEvmPool(store,job.payload.chain,job.payload.log);
  case 'EVM_CATCHUP':{const chain=await store.get("SELECT * FROM chains WHERE id='robinhood' AND enabled=1");if(chain)return evmCatchup(chain);return;}
  default:throw Error('UNKNOWN_JOB_TYPE');
 }
}
async function perform(job){
 active.set(job.id,{type:job.type,at:Date.now()});
 try{const result=await work(job);const interval=job.payload.interval_ms??0;await store.run("UPDATE engine_jobs SET state='DONE',owner=NULL,locked_at=NULL,updated_at=?,available_at=?,error=NULL WHERE id=? AND owner=?",Date.now(),Date.now()+interval,job.id,owner);lastCompleted=Date.now();return result;}
 catch(e){const error=safeError(e),retry=job.attempts<4||['WALLET_TX','SOLANA_POOL','EVM_POOL','SOLANA_CATCHUP'].includes(job.type);lastError=error;await store.run("UPDATE engine_jobs SET state=?,owner=NULL,locked_at=NULL,updated_at=?,available_at=?,error=? WHERE id=? AND owner=?",retry?'QUEUED':'FAILED',Date.now(),Date.now()+Math.min(300000,2000*2**Math.min(8,job.attempts)),error,job.id,owner);await emit(store,'ERROR',job.type+' · '+(retry?'reintento programado':'trabajo fallido'),{error,attempts:job.attempts,job_id:job.id});if(job.payload.wallet_id)await store.run('UPDATE watched_wallets SET error=? WHERE wallet_id=?',error,job.payload.wallet_id);}
 finally{active.delete(job.id);}
}
async function schedule(){
 if(closing||!ready)return;
 const desired=await store.setting('engine_desired');
 if(desired!=='RUNNING'){
  if(streamsActive){await streams.stop();streamsActive=false;}
  // Already broadcast transactions still need confirmation, even during a stop.
  if(Date.now()-lastMaintain>10000&&!active.has('maintenance-reconcile')){lastMaintain=Date.now();active.set('maintenance-reconcile',{type:'RECONCILE',at:Date.now()});reconcileWithPrices(store,await resolveOptions(store,options)).catch(e=>{lastError=safeError(e);}).finally(()=>active.delete('maintenance-reconcile'));}
  return;
 }
 const config=await store.setting('engine_config');
 if(Date.now()-lastRefresh>10000){lastRefresh=Date.now();await streams.refresh();streamsActive=true;}
 await recurring('paper-exits','PAPER_EXITS',{},5000);await recurring('scan','SCAN',{},config.scan_interval_ms);await recurring('health','HEALTH',{},15000);await recurring('reconcile','RECONCILE',{},5000);await recurring('learning','LEARNING',{},60000);if((await store.setting('training_config'))?.enabled)await recurring('training-market','TRAINING_MARKET',{},15000);await recurring('evm-catchup','EVM_CATCHUP',{},30000);
 for(const w of await store.all('SELECT * FROM watched_wallets WHERE enabled=1'))await recurring('watch:'+w.wallet_id,'WALLET_POLL',{wallet_id:w.wallet_id},w.catchup_before?5000:config.wallet_interval_ms);
 while(active.size<config.concurrency){
  const critical=['PAPER_EXITS','RECONCILE'];
  const reserve=config.concurrency>1&&active.size>=config.concurrency-1&&![...active.values()].some(job=>critical.includes(job.type));
  const job=await claimJob(store,owner,reserve?critical:null);if(!job)break;perform(job).catch(e=>{lastError=safeError(e);});
 }
 if(Date.now()-lastMaintain>3600000){lastMaintain=Date.now();const cutoff=Date.now()-config.retention_days*86400000;
  await store.run('DELETE FROM engine_events WHERE at<?',cutoff);await store.run("DELETE FROM engine_jobs WHERE state='DONE' AND updated_at<? AND type IN ('WALLET_TX','SOLANA_POOL','EVM_POOL')",cutoff);
  await store.run('DELETE FROM market_snapshots WHERE received_at<? AND id NOT IN (SELECT snapshot_id FROM trader_context WHERE snapshot_id IS NOT NULL) AND id NOT IN (SELECT MAX(id) FROM market_snapshots GROUP BY token_id)',cutoff);
  await store.run('DELETE FROM signals WHERE observed_at<? AND id NOT IN (SELECT signal_id FROM order_context WHERE signal_id IS NOT NULL)',cutoff);
 }
}
await heartbeat();const beat=setInterval(heartbeat,2000);let scheduling=false;const timer=setInterval(async()=>{if(scheduling)return;scheduling=true;try{await schedule();}catch(e){lastError=safeError(e);await emit(store,'ERROR','Error del planificador',{error:lastError}).catch(()=>{});}finally{scheduling=false;}},500);
async function shutdown(){if(closing)return;closing=true;clearInterval(timer);clearInterval(beat);await streams.stop();await copyEngine.stop();const until=Date.now()+15000;while(active.size&&Date.now()<until)await new Promise(r=>setTimeout(r,100));await store.run("DELETE FROM settings WHERE key='engine_lease' AND json_extract(value,'$.owner')=?",owner);db.close();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,shutdown);
process.on('disconnect',shutdown);
