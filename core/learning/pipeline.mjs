import {PROTOCOL,featureError,fitModel,metrics} from './model.mjs';
import {verifiedWalletSwaps} from './solana-evidence.mjs';
import {DexScreenerProvider} from '../providers/market.mjs';
import {SOL,USDC} from '../providers/chains.mjs';
import {id,json,digest,fail,safeError} from '../util.mjs';
import {emit} from '../engine-state.mjs';

const horizon=PROTOCOL.horizon_ms+PROTOCOL.max_gap_ms*3;
const normalize=s=>Object.fromEntries(['id','token_id','pool_id','observed_at','received_at','price','liquidity','market_cap','volume_5m','buys_5m','sells_5m','change_5m','pool_created','source'].map(k=>[k,s[k]??null]));
const sample=s=>({...s,features:json(s.features),trajectory:json(s.trajectory,[]),evidence:json(s.evidence,{})});

export async function captureTrainingSamples(store,now=Date.now()) {
  const owner=id();const lock=await store.run("INSERT INTO settings VALUES ('training_capture_lease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE json_extract(settings.value,'$.until')<?",JSON.stringify({owner,until:now+60000}),now,now);
  if(!lock.changes)return;
  try{return await captureUnlocked(store,now);}
  finally{await store.run("DELETE FROM settings WHERE key='training_capture_lease' AND json_extract(value,'$.owner')=?",owner);}
}
async function captureUnlocked(store,now) {
  const config=await store.setting('training_config');if(!config?.enabled)return;
  const active=await store.all("SELECT * FROM learning_samples WHERE state='CAPTURING' ORDER BY anchor_at");
  for(const row of active){
    const s=sample(row),last=s.trajectory.at(-1)?.received_at??s.anchor_at;
    const fresh=await store.all('SELECT m.*,p.created_at pool_created FROM market_snapshots m LEFT JOIN pools p ON p.id=m.pool_id WHERE m.token_id=? AND m.received_at>? AND m.received_at<=? ORDER BY m.received_at,m.id LIMIT 200',s.token_id,last,Math.min(now,s.end_at));
    let previous=last,reason=null;
    for(const point of fresh){
      if(point.received_at-previous>PROTOCOL.max_gap_ms||!point.price||!point.liquidity||point.observed_at>point.received_at){reason='PRICE_GAP';break;}
      s.trajectory.push(normalize(point));previous=point.received_at;
    }
    if(now-previous>PROTOCOL.max_gap_ms&&now<s.end_at)reason='PRICE_GAP';
    let state=reason?'EXCLUDED':now>=s.end_at?'READY':'CAPTURING';
    if(state==='READY'&&(s.trajectory.length<10||s.end_at-previous>PROTOCOL.max_gap_ms)){state='EXCLUDED';reason='INCOMPLETE_OUTCOME';}
    await store.run('UPDATE learning_samples SET trajectory=?,state=?,reason=?,updated_at=? WHERE id=? AND state=\'CAPTURING\'',JSON.stringify(s.trajectory),state,reason,now,s.id);
  }
  const n=(await store.get("SELECT COUNT(*) n FROM learning_samples WHERE state='CAPTURING'")).n;
  if(n>=config.max_active_tokens)return;
  const wallets=await store.all("SELECT w.id,w.address,w.chain,v.error,v.last_sync,(SELECT COUNT(*) FROM transactions t WHERE t.wallet_id=w.id) transactions FROM wallets w JOIN watched_wallets v ON v.wallet_id=w.id WHERE v.enabled=1");
  if(!wallets.some(w=>w.chain==='solana'))return;
  // Qualification uses instruction + recipient balance evidence, not arbitrary
  // paired transfers. The sample clock starts at OUR actual observation.
  const txs=await store.all("SELECT t.* FROM transactions t JOIN watched_wallets w ON w.wallet_id=t.wallet_id JOIN wallets a ON a.id=t.wallet_id WHERE w.enabled=1 AND t.chain='solana' AND t.status='CONFIRMED' AND t.received_at>=? AND t.occurred_at>=? ORDER BY t.received_at DESC LIMIT 100",now-180000,now-300000);
  const entries=new Map();
  for(const tx of txs){
    const wallet=wallets.find(w=>w.id===tx.wallet_id);if(!wallet)continue;
    for(const swap of verifiedWalletSwaps(json(tx.raw,{}),wallet.address).filter(f=>f.side==='INFERRED_BUY'))entries.set('solana:'+swap.token_address,{tx,wallet,swap});
  }
  const rows=await store.all("SELECT m.*,p.created_at pool_created FROM market_snapshots m JOIN tokens t ON t.id=m.token_id LEFT JOIN pools p ON p.id=m.pool_id WHERE t.chain='solana' AND m.received_at>=? AND m.id=(SELECT MAX(x.id) FROM market_snapshots x WHERE x.token_id=m.token_id) AND NOT EXISTS(SELECT 1 FROM learning_samples s WHERE s.token_id=m.token_id) ORDER BY m.received_at DESC LIMIT 100",now-45000);
  const valid=rows.filter(s=>![SOL,USDC].includes(s.token_id.split(':')[1])&&!featureError(s));
  const fromWallet=valid.filter(s=>entries.has(s.token_id)&&entries.get(s.token_id).tx.received_at<=s.received_at);
  const market=valid.filter(s=>!entries.has(s.token_id));
  const prioritized=[];for(let i=0;i<Math.max(fromWallet.length,market.length);i++){if(fromWallet[i])prioritized.push(fromWallet[i]);if(market[i])prioritized.push(market[i]);}
  const bySource={WALLET:active.filter(s=>s.source==='WALLET'&&s.end_at>now).length,MARKET:active.filter(s=>s.source==='MARKET'&&s.end_at>now).length};
  const lastFreeze=(await store.get('SELECT MAX(created_at) at FROM learning_runs'))?.at??0;
  let inserted=0;
  for(const snapshot of prioritized){
    if(inserted>=config.max_active_tokens-n)break;
    const e=entries.get(snapshot.token_id),sid=id(),source=e?'WALLET':'MARKET';
    if(bySource[source]>=Math.ceil(config.max_active_tokens/2)||snapshot.received_at<=lastFreeze)continue;
    const evidence={kind:source,market_source:snapshot.source,anchor_snapshot_id:snapshot.id,decision_time:snapshot.received_at,
      context:'OUR_OBSERVATION_AFTER_DETECTION',wallet:e?{id:e.wallet.id,address:e.wallet.address,hash:e.tx.hash,block:e.tx.block,occurred_at:e.tx.occurred_at,received_at:e.tx.received_at,swap:e.swap,receipt:json(e.tx.raw)}:null};
    await store.run('INSERT OR IGNORE INTO learning_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',sid,snapshot.token_id,source,e?.wallet.id??null,snapshot.received_at,snapshot.received_at+horizon,'CAPTURING',null,JSON.stringify(normalize(snapshot)),'[]',JSON.stringify(evidence),null,now);
    bySource[source]++;inserted++;
  }
  await store.set('training_capture',{at:now,invalid_context:rows.length-valid.length,recent_transactions:txs.length,verified_recent_buys:entries.size,unsupported_or_nonbuy_transactions:Math.max(0,txs.length-entries.size)});
}

export async function refreshTrainingMarket(store) {
  if(!(await store.setting('training_config'))?.enabled)return;
  const now=Date.now();
  const rows=await store.all("SELECT s.token_id FROM learning_samples s LEFT JOIN market_snapshots m ON m.id=(SELECT MAX(x.id) FROM market_snapshots x WHERE x.token_id=s.token_id) WHERE s.state='CAPTURING' AND s.end_at>? ORDER BY COALESCE(m.received_at,0) LIMIT 4",now);
  const provider=new DexScreenerProvider();
  const results=await Promise.allSettled(rows.map(async r=>{
    const token=await store.get('SELECT * FROM tokens WHERE id=?',r.token_id);
    if(token)await provider.record(store,token.chain,token.address);
  }));
  const errors=results.filter(r=>r.status==='rejected').map(r=>safeError(r.reason));
  if(errors.length)await store.set('training_market_error',{at:Date.now(),message:errors[0],failed:errors.length});
  else if(rows.length)await store.set('training_market_error',null);
  await captureTrainingSamples(store);
}

export async function trainIfReady(store,now=Date.now()) {
  if(!(await store.setting('training_config'))?.enabled)return {status:'PAUSED'};
  const owner=id();const lease=await store.run("INSERT INTO settings VALUES ('training_lease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE json_extract(settings.value,'$.until')<?",JSON.stringify({owner,until:now+120000}),now,now);
  if(!lease.changes)return {status:'BUSY'};
  try{
    await captureTrainingSamples(store,now);
    // Time-stratified, bounded sampling per source; never choose by outcome.
    // Include incomplete/rug episodes and span the whole unused observation period.
    const rows=await store.all("WITH ranked AS (SELECT s.*,ROW_NUMBER() OVER(PARTITION BY source ORDER BY anchor_at,id) rn,COUNT(*) OVER(PARTITION BY source) source_count FROM learning_samples s WHERE state IN ('READY','EXCLUDED') AND used_run_id IS NULL) SELECT * FROM ranked WHERE (rn-1)%MAX(1,CAST((source_count+249)/250 AS INTEGER))=0 ORDER BY anchor_at LIMIT 500");
    const samples=rows.map(sample);
    if(samples.length<PROTOCOL.min_samples){const status={at:now,status:'COLLECTING',ready:samples.length,required:PROTOCOL.min_samples};await store.set('training_status',status);return status;}
    if(samples.at(-1).anchor_at-samples[0].anchor_at<PROTOCOL.min_span_ms){const status={at:now,status:'COLLECTING',reason:'OBSERVATION_SPAN',ready:samples.length,required:PROTOCOL.min_samples};await store.set('training_status',status);return status;}
    await store.set('training_status',{at:now,status:'TRAINING',ready:samples.length});
    await emit(store,'TRAINING','Entrenamiento de reglas iniciado',{tokens:samples.length,protocol:PROTOCOL.version});
    const fit=fitModel(samples);
    if(!fit.trained){const status={at:now,status:'COLLECTING',reason:fit.reason,ready:samples.length,required:PROTOCOL.min_samples,wallet_train:fit.split.train.filter(s=>s.source==='WALLET').length};await store.set('training_status',status);return status;}
    const runId=id(),datasetId=id(),versionId=fit.parameters?id():null;
    const population=await store.get("SELECT COUNT(*) n FROM learning_samples WHERE used_run_id IS NULL AND anchor_at<=?",now);
    const manifest={protocol:PROTOCOL,freeze_at:now,sampling:'TIME_STRATIFIED_MAX_250_PER_SOURCE',population:population.n,sampled:samples.length,samples,split:{train:fit.split.train.map(s=>s.id),validation:fit.split.validation.map(s=>s.id),test:fit.split.test.map(s=>s.id),validation_at:fit.split.validation_at,test_at:fit.split.test_at,embargo_ms:fit.split.embargo_ms,purged:fit.split.excluded}};
    const serialized=JSON.stringify(manifest),hash=await digest(serialized);
    const {split,...result}=fit;result.entry_policy='FIRST_COMPLETE_OBSERVATION_ONCE_PER_TOKEN_VERSION';result.membership=manifest.split;result.protocol=PROTOCOL;result.dataset_digest=hash;result.no_trade_control={pnl_cents:0};
    const statements=[['INSERT INTO datasets VALUES (?,?,?,?,?,?,?)',[datasetId,now,samples[0].anchor_at,samples.at(-1).end_at,samples.reduce((n,s)=>n+s.trajectory.length+1,0),hash,serialized]],
      ['INSERT INTO learning_runs(id,created_at,dataset_id,dataset_digest,status,version_id,result,paper_run_id) VALUES (?,?,?,?,?,?,?,?)',[runId,now,datasetId,hash,fit.status,versionId,JSON.stringify(result),null]]];
    if(versionId){
      const strategyId='b20ed31f-8322-40db-8198-6db203d96a99';
      const v=await store.get('SELECT MAX(version) n FROM strategy_versions WHERE strategy_id=?',strategyId);
      statements.push(['INSERT OR IGNORE INTO strategies VALUES (?,?,?)',[strategyId,'Aprendida · wallets Solana',now]],
        ['INSERT INTO strategy_versions VALUES (?,?,?,?,?,?,?)',[versionId,strategyId,(v?.n??0)+1,now,JSON.stringify(fit.parameters),datasetId,fit.status==='PAPER_ELIGIBLE'?'TRAINED_PAPER_ONLY':'TRAINED_REJECTED']]);
    }
    // Retire the whole observation period. Unselected rows cannot later become
    // another supposedly fresh holdout from the same training window.
    statements.push(['UPDATE learning_samples SET used_run_id=? WHERE anchor_at<=? AND used_run_id IS NULL',[runId,now]]);
    await store.batch(statements);
    await store.set('training_status',{at:now,status:fit.status,run_id:runId,ready:samples.length});
    await emit(store,'TRAINING',fit.status==='PAPER_ELIGIBLE'?'Estrategia aprendida: disponible para probar en PAPER':'Estrategia entrenada: no superó la validación',{run_id:runId,version_id:versionId,status:fit.status,test:fit.test?{trades:fit.test.trades,pnl_cents:fit.test.pnl_cents}:null,checks:fit.checks??{},live_enabled:false});
    return {id:runId,status:fit.status};
  }catch(e){await store.set('training_status',{at:Date.now(),status:'ERROR',error:safeError(e)});throw e;}
  finally{await store.run("DELETE FROM settings WHERE key='training_lease' AND json_extract(value,'$.owner')=?",owner);}
}

export async function trainingSummary(store,now=Date.now()) {
  const counts=await store.all('SELECT state,source,COUNT(*) count FROM learning_samples GROUP BY state,source');
  const available=await store.get("SELECT COUNT(*) n FROM learning_samples WHERE state IN ('READY','EXCLUDED') AND used_run_id IS NULL");
  const recent=await store.all('SELECT id,created_at,status,version_id,result,paper_run_id FROM learning_runs ORDER BY created_at DESC LIMIT 5');
  const runs=[];
  for(const run of recent){
    const r=json(run.result,{}),brief=v=>{if(!v)return v;const {trade_records,...m}=v;return m;},proof=run.paper_run_id?await paperEvidence(store,run,now):null;
    runs.push({...run,result:{trained:r.trained,train:brief(r.train),validation:brief(r.validation),test:brief(r.test),baseline:brief(r.baseline),checks:r.checks,reason:r.reason,parameters:r.parameters,candidate_count:r.candidate_count,dataset_digest:r.dataset_digest,membership:r.membership},paper:proof});
  }
  const exclusions=await store.all("SELECT reason,COUNT(*) count FROM learning_samples WHERE state='EXCLUDED' GROUP BY reason");
  const wallets=await store.all("SELECT w.id,w.label,w.address,w.chain,v.enabled,v.error,(SELECT COUNT(*) FROM transactions t WHERE t.wallet_id=w.id) transactions,(SELECT COUNT(*) FROM transactions t WHERE t.wallet_id=w.id AND t.status='FAILED') failed,(SELECT COUNT(*) FROM learning_samples s WHERE s.wallet_id=w.id) samples FROM wallets w LEFT JOIN watched_wallets v ON v.wallet_id=w.id");
  return {available:true,config:await store.setting('training_config'),status:await store.setting('training_status'),capture:await store.setting('training_capture'),market_error:await store.setting('training_market_error'),counts,ready:available.n,required:PROTOCOL.min_samples,required_wallet_train:PROTOCOL.min_wallet_train,exclusions,wallets,runs,protocol:PROTOCOL,live:'MANUAL_REVIEW_REQUIRED',scope:'Solana · verified PumpSwap wallet buys + observed scanner tokens'};
}

export async function paperEvidence(store,training,now=Date.now()) {
  const run=await store.get("SELECT * FROM runs WHERE id=? AND mode='PAPER' AND version_id=?",training.paper_run_id,training.version_id);if(!run)return null;
  const positions=await store.all("SELECT p.*,m.price current_price,m.received_at FROM positions p LEFT JOIN market_snapshots m ON m.id=(SELECT MAX(x.id) FROM market_snapshots x WHERE x.token_id=p.token_id) WHERE p.run_id=? AND p.mode='PAPER' AND p.version_id=?",run.id,training.version_id);
  const closed=positions.filter(p=>p.closed_at),unpriced=positions.filter(p=>!p.closed_at&&(!p.current_price||now-p.received_at>45000));
  const stats=metrics(closed.map(p=>({token_id:p.token_id,pnl_cents:p.realized_cents,exit_at:p.closed_at,source:'PAPER'})));
  const daySpan=closed.length?(Math.max(...closed.map(p=>p.closed_at))-run.started_at)/86400000:0;
  const evidenceCount=(await store.get("SELECT COUNT(*) n FROM orders WHERE run_id=? AND mode='PAPER' AND state='PAPER_FILLED' AND quote IS NOT NULL",run.id)).n;
  const checks={fresh_version:run.started_at>=training.created_at,closed_trades:closed.length>=50,distinct_tokens:stats.distinct_tokens>=30,days:daySpan>=7,positive_net:stats.lower_mean_cents>0,drawdown:stats.max_drawdown<=.1,no_open_positions:positions.length===closed.length,quotes_recorded:evidenceCount>=closed.length*2};
  return {run_id:run.id,status:run.status,...stats,open_positions:positions.length-closed.length,unpriced:unpriced.length,days:daySpan,checks,review_ready:Object.values(checks).every(Boolean),live_enabled:false};
}

export async function startTrainingPaper(store,trainingId,options={}) {
  fail(options.engineAvailable,'ENGINE_NOT_PROVISIONED');
  const training=await store.get('SELECT * FROM learning_runs WHERE id=?',trainingId);
  fail(training?.status==='PAPER_ELIGIBLE'&&training.version_id,'TRAINING_NOT_PAPER_ELIGIBLE');
  if(training.paper_run_id)return {id:training.paper_run_id,mode:'PAPER',capital_cents:10000,existing:true};
  fail(!String(await store.setting('mode')).startsWith('LIVE'),'STOP_LIVE_BEFORE_TRAINING_PAPER');
  await assertNoLiveWork(store);
  fail(!await store.get("SELECT id FROM runs WHERE status IN ('RUNNING','LOSS_LIMIT') LIMIT 1"),'ANOTHER_PAPER_SESSION_ACTIVE');
  fail(!await store.get('SELECT id FROM positions WHERE closed_at IS NULL LIMIT 1'),'OPEN_POSITIONS_KEEP_SESSION');
  const version=await store.get('SELECT * FROM strategy_versions WHERE id=?',training.version_id);fail(version?.stage==='TRAINED_PAPER_ONLY','TRAINED_VERSION_REQUIRED');
  const parameters=json(version.parameters),now=Date.now(),runId=id(),epoch=await store.setting('epoch');
  const config={...parameters,version_id:version.id,training_id:training.id,capital_cents:10000,order_cents:200,max_positions:3,reserve_pct:60,daily_loss_cents:1000,slippage_bps:100,network_fee_cents:3,max_impact_pct:2};
  // Idempotent FK-like claim is in the same transaction as session creation.
  const statements=[
    ["INSERT INTO runs SELECT ?, 'PAPER','RUNNING',10000,10000,?,?,?,NULL WHERE EXISTS(SELECT 1 FROM learning_runs WHERE id=? AND paper_run_id IS NULL) AND NOT EXISTS(SELECT 1 FROM runs WHERE status IN ('RUNNING','LOSS_LIMIT')) AND NOT EXISTS(SELECT 1 FROM positions WHERE closed_at IS NULL) AND CAST((SELECT value FROM settings WHERE key='epoch') AS INTEGER)=? AND NOT EXISTS(SELECT 1 FROM settings WHERE key='mode' AND json_extract(value,'$') LIKE 'LIVE%') AND NOT EXISTS(SELECT 1 FROM settings WHERE key='copy_config' AND (json_extract(value,'$.live_enabled')=1 OR json_extract(value,'$.auto_armed')=1)) AND NOT EXISTS(SELECT 1 FROM copy_targets WHERE enabled=1 AND json_extract(config,'$.mode') LIKE 'LIVE%')",[runId,version.id,JSON.stringify(config),now,training.id,epoch]],
    ['UPDATE learning_runs SET paper_run_id=? WHERE id=? AND paper_run_id IS NULL AND EXISTS(SELECT 1 FROM runs WHERE id=?)',[runId,training.id,runId]],
  ];
  for(const [key,value] of Object.entries({mode:'PAPER',trading_enabled:true,entries_paused:false,engine_desired:'RUNNING',engine_enforced:true,epoch:epoch+1}))statements.push(['INSERT INTO settings SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[key,JSON.stringify(value),now,runId]]);
  statements.push(["UPDATE settings SET value=?,updated_at=? WHERE key='engine_started_at' AND EXISTS(SELECT 1 FROM runs WHERE id=?) AND (value='null' OR value IS NULL)",[String(now),now,runId]]);
  await store.batch(statements);
  fail(await store.get('SELECT id FROM runs WHERE id=?',runId),'PAPER_SESSION_CONFLICT');
  await emit(store,'TRAINING','Prueba futura iniciada con US$100 virtuales',{training_id:training.id,run_id:runId,version_id:version.id,capital_cents:10000,live_enabled:false});
  return {id:runId,mode:'PAPER',capital_cents:10000};
}

export async function assertNoLiveWork(store) {
  fail(!String(await store.setting('mode')).startsWith('LIVE'),'STOP_LIVE_BEFORE_TRAINING');
  const copy=await store.setting('copy_config');
  fail(!copy?.live_enabled&&!copy?.auto_armed,'STOP_LIVE_COPY_BEFORE_TRAINING');
  fail(!await store.get("SELECT id FROM copy_targets WHERE enabled=1 AND json_extract(config,'$.mode') LIKE 'LIVE%' LIMIT 1"),'STOP_LIVE_COPY_BEFORE_TRAINING');
  fail(!await store.get("SELECT id FROM orders WHERE mode LIKE 'LIVE%' AND state NOT IN ('CANCELLED','REJECTED','FAILED','RECONCILED','EXPIRED') LIMIT 1"),'PENDING_LIVE_ORDERS');
  fail(!await store.get("SELECT order_id FROM reservations WHERE status='ACTIVE' LIMIT 1"),'ACTIVE_LIVE_RESERVATIONS');
  fail(!await store.get("SELECT id FROM copy_actions WHERE mode LIKE 'LIVE%' AND state NOT IN ('CANCELLED','REJECTED','FAILED','CONFIRMED','RECONCILED','EXPIRED') LIMIT 1"),'PENDING_LIVE_COPY');
  fail(!await store.get("SELECT id FROM copy_positions WHERE mode LIKE 'LIVE%' AND closed_at IS NULL LIMIT 1"),'OPEN_LIVE_COPY_POSITIONS');
}
