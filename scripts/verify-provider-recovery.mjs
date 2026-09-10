// Real-provider check in an isolated, entry-paused PAPER session. No browser client.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {Store} from '../core/store.mjs';
import {USDC,SOL} from '../core/providers/chains.mjs';
import {baseline} from '../core/strategy.mjs';
import {safeError} from '../core/util.mjs';
const dir=await mkdtemp(join(tmpdir(),'meme-lab-provider-check-')),db=sqliteDriver(join(dir,'meme-lab.sqlite')),store=new Store(db);
await store.init();await store.run("UPDATE chains SET enabled=CASE WHEN id='solana' THEN 1 ELSE 0 END");await store.run("UPDATE chains SET rpc_url='https://solana-rpc.publicnode.com',ws_url='wss://solana-rpc.publicnode.com' WHERE id='solana'");
await store.set('engine_desired','RUNNING');await store.set('mode','PAPER');await store.set('trading_enabled',true);await store.set('entries_paused',true);await store.set('engine_started_at',Date.now());await store.set('engine_config',{scan_interval_ms:15000,wallet_interval_ms:30000,concurrency:3,max_tokens:4,retention_days:7});
await store.run('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)','verification','PAPER','RUNNING',10000,10000,null,JSON.stringify({...baseline,order_cents:200,network_fee_cents:3,max_positions:2,reserve_pct:60,daily_loss_cents:1000}),Date.now(),null);
const evidence={at:new Date().toISOString(),status:'RUNNING',checks:[],limits:[]},started=Date.now();
const server=spawn(process.execPath,['runtime/server.mjs'],{env:{...process.env,DATA_DIR:dir,PORT:'8798',HOST:'127.0.0.1',DISABLE_WORKER:'0'},stdio:['ignore','pipe','pipe']});
try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('SERVER_START_TIMEOUT')),15000);server.stdout.on('data',d=>{if(String(d).includes('MEME LAB running')){clearTimeout(timer);resolve();}});server.once('exit',code=>{clearTimeout(timer);reject(Error('SERVER_EXIT_'+code));});});
 console.log('Engine started with no browser and an empty PAPER portfolio; new entries paused.');
 while(Date.now()-started<75000){
  await new Promise(r=>setTimeout(r,2000));
  const stable=await store.get('SELECT COUNT(*) n,MAX(received_at)-MIN(received_at) span FROM market_snapshots WHERE token_id=?','solana:'+USDC);
  const ws=await store.get("SELECT last_event FROM ws_health WHERE chain='solana'");
  if(Date.now()-started>=35000&&stable.n>=2&&stable.span>=15000&&ws?.last_event)break;
 }
 const heartbeat=await store.setting('engine_heartbeat'),run=await store.get("SELECT cash_cents FROM runs WHERE id='verification'");
 evidence.heartbeat=heartbeat;evidence.prices=await store.all('SELECT token_id,price,received_at,source FROM market_snapshots WHERE token_id IN (?,?) ORDER BY received_at','solana:'+USDC,'solana:'+SOL);evidence.networks=await store.all('SELECT * FROM ws_health');evidence.providers=await store.all('SELECT * FROM provider_health');evidence.scan=await store.setting('scanner_last_tick');evidence.errors=await store.all("SELECT at,message,data FROM engine_events WHERE kind IN ('RISK','ERROR') ORDER BY id DESC LIMIT 12");
 const usdc=evidence.prices.filter(p=>p.token_id==='solana:'+USDC),orders=await store.get('SELECT COUNT(*) n FROM orders');
 if(heartbeat&&Date.now()-heartbeat.at<15000)evidence.checks.push('Background worker kept sending heartbeat with no browser');else throw Error('HEARTBEAT_NOT_FRESH');
 if(run.cash_cents===10000&&orders.n===0)evidence.checks.push('Paused virtual balance preserved; no orders or funded broadcasts');else throw Error('UNEXPECTED_LEDGER_CHANGE');
 if(usdc.length>=2&&usdc.at(-1).received_at-usdc[0].received_at>=15000)evidence.checks.push('Real USDC prices refreshed repeatedly with zero positions');else evidence.limits.push('Provider did not supply repeated USDC observations in the 75-second window');
 if(evidence.networks.some(n=>n.last_event))evidence.checks.push('Real Solana WebSocket event recorded');else evidence.limits.push('No real WebSocket event during this check');
 evidence.status=evidence.limits.length?'PASSED_WITH_PROVIDER_LIMITATIONS':'PASSED';
}catch(e){evidence.status='FAILED';evidence.error=safeError(e);process.exitCode=1;}
finally{
 if(server.exitCode===null){const ended=once(server,'exit');server.kill('SIGTERM');await ended;}
 evidence.duration_seconds=Math.round((Date.now()-started)/1000);await writeFile('docs/evidence/provider-recovery-verification.json',JSON.stringify(evidence,null,2));db.close();await rm(dir,{recursive:true,force:true});console.log(JSON.stringify({status:evidence.status,checks:evidence.checks,limits:evidence.limits,duration_seconds:evidence.duration_seconds}));
}
