import {DexScreenerProvider,recordMarketError} from './providers/market.mjs';
import {checkHealth,adapter,SOL,USDC,RH} from './providers/chains.mjs';
import {evaluate} from './strategy.mjs';
import {paperTick} from './paper.mjs';
import {automatedOrders} from './automation.mjs';
import {ExecutionEngine} from './execution/engine.mjs';
import {emit} from './engine-state.mjs';
import {id,json,safeError} from './util.mjs';
export function marketQueue({chains,positions,discovered,existing,limit=12,cursor=0}){
 const enabled=new Set(chains.map(c=>c.id)),normalize=x=>({chainId:x.chainId??x.chain,tokenAddress:x.tokenAddress??x.address});
 const mandatory=[{chainId:'solana',tokenAddress:USDC},...positions.map(normalize),{chainId:'solana',tokenAddress:SOL}].filter(t=>enabled.has(t.chainId));
 const rotated=existing.length?[...existing.slice(cursor%existing.length),...existing.slice(0,cursor%existing.length)]:[];
 const fresh=discovered.filter(t=>!existing.some(e=>e.chain===t.chainId&&e.address===t.tokenAddress));
 const optional=[];for(let i=0;i<Math.max(fresh.length,rotated.length);i++){if(fresh[i])optional.push(normalize(fresh[i]));if(rotated[i])optional.push(normalize(rotated[i]));}
 const unique=rows=>[...new Map(rows.filter(t=>enabled.has(t.chainId)).map(t=>[t.chainId+':'+t.tokenAddress,t])).values()];
 // All open positions are mandatory. The normal budget applies to remaining discovery.
 return unique([...mandatory,...optional]).slice(0,Math.max(unique(mandatory).length,limit));
}
export async function scanOnce(store,options={}){
 const started=Date.now(),owner=id();const r=await store.run("INSERT INTO settings(key,value,updated_at) VALUES ('scanner_lease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE json_extract(settings.value,'$.until')<?",JSON.stringify({owner,until:started+600000}),started,started);if(!r.changes)return {status:'ALREADY_RUNNING'};
 let processed=0,rejected=0;try{
  const chains=await store.all('SELECT * FROM chains WHERE enabled=1');if(!options.skipHealth)await Promise.allSettled(chains.map(c=>checkHealth(store,c)));
  const market=new DexScreenerProvider();
  // Funding prices cannot wait behind discovery, metadata or an empty watch list.
  if(chains.some(c=>c.id==='solana'))await Promise.allSettled([USDC,SOL].map(async address=>{try{await market.record(store,'solana',address);}catch(e){await recordMarketError(store,e);await emit(store,'ERROR','Precio de referencia no disponible',{address,error:safeError(e),retry_at:e.retryAt??null},'solana');}}));
  let discovered=[];try{discovered=await market.discover(store);}catch(e){await recordMarketError(store,e);await emit(store,'ERROR','Discovery no disponible',{error:safeError(e),retry_at:e.retryAt??null});}
  const existing=await store.all('SELECT chain,address FROM tokens ORDER BY first_seen DESC LIMIT 500');
  const positions=await store.all('SELECT DISTINCT t.chain,t.address FROM positions p JOIN tokens t ON t.id=p.token_id WHERE p.closed_at IS NULL');
  const config=await store.setting('engine_config'),cursor=await store.setting('scanner_cursor')??0;
  const queue=marketQueue({chains,positions,discovered,existing,cursor,limit:config?.max_tokens??12});await store.set('scanner_cursor',cursor+Math.max(1,queue.length-positions.length-2));
  const versions=await store.all("SELECT v.*,s.name FROM strategy_versions v JOIN strategies s ON s.id=v.strategy_id WHERE v.id IN (SELECT version_id FROM runs WHERE status IN ('RUNNING','LOSS_LIMIT')) OR v.version=(SELECT MAX(v2.version) FROM strategy_versions v2 WHERE v2.strategy_id=v.strategy_id) LIMIT 20");
  const signals=[];let dispatched=0,marketUnavailable=false;const mode=await store.setting('mode');await emit(store,'SCAN','Ciclo de mercado iniciado',{tokens:queue.length,open_position_tokens:positions.length});
  for(let i=0;i<queue.length;i+=2){
   if(Date.now()-started>90000){await emit(store,'ERROR','Ciclo acotado por latencia: continúa en el siguiente trabajo');break;}
   await Promise.allSettled(queue.slice(i,i+2).map(async t=>{
    try{
     const tokenId=await market.record(store,t.chainId,t.tokenAddress);let token=await store.get('SELECT * FROM tokens WHERE id=?',tokenId),metadataAttempted=false;
     processed++;const snap=await store.get('SELECT * FROM market_snapshots WHERE token_id=? ORDER BY received_at DESC LIMIT 1',tokenId);const pool=await store.get('SELECT * FROM pools WHERE id=?',snap.pool_id);
     for(const v of versions){const params=json(v.parameters);if(params.chain!==t.chainId)continue;const began=Date.now(),result=evaluate(snap,params,token,pool),signal={id:id(),token_id:tokenId,version_id:v.id,observed_at:snap.received_at,...result};
      await store.run('INSERT INTO signals VALUES (?,?,?,?,?,?,?,?,?)',signal.id,tokenId,v.id,mode,result.decision,result.score,JSON.stringify(result.reasons),Date.now(),Date.now()-began);
      await emit(store,'DECISION',`${v.name} v${v.version} · ${result.decision} · score ${result.score}`,{signal_id:signal.id,token_address:t.tokenAddress,symbol:token.symbol,strategy:v.name,version:v.version,score:result.score,decision:result.decision,reasons:result.reasons,market_cap:snap.market_cap,price:snap.price},t.chainId,signal.id);
      if(result.decision==='SIGNAL'){
       // Rejected tokens need no RPC metadata request. Accepted tokens still require it.
       if(token.decimals===null&&!metadataAttempted){metadataAttempted=true;try{const info=await adapter(chains.find(c=>c.id===t.chainId)).token(t.tokenAddress);await store.run('UPDATE tokens SET decimals=? WHERE id=?',info.decimals,tokenId);token.decimals=info.decimals;}catch(e){await emit(store,'ERROR','Metadata on-chain no disponible',{address:t.tokenAddress,error:safeError(e)},t.chainId,tokenId);}}
       signals.push(signal);
      }else rejected++;
     }
    }catch(e){await recordMarketError(store,e);if(e.provider||/PROVIDER_(COOLDOWN|TIMEOUT|HTTP_429)/.test(e.message))marketUnavailable=true;await emit(store,e.message==='NO_INDEXED_POOLS'?'MARKET':'ERROR',e.message==='NO_INDEXED_POOLS'?'Token todavía sin pool indexada':'Token sin datos utilizables',{address:t.tokenAddress,error:safeError(e),retry_at:e.retryAt??null},t.chainId);}
   }));
   // Execute newly evaluated signals while their market context is fresh, before optional discovery.
   if(await store.setting('trading_enabled')){
    const fresh=signals.slice(dispatched);dispatched=signals.length;
    const runs=await store.all("SELECT * FROM runs WHERE status IN ('RUNNING','LOSS_LIMIT') AND mode='PAPER'");
    for(const run of runs){const candidates=fresh.filter(s=>s.version_id===run.version_id);if(candidates.length)await paperTick(store,run,candidates,{...options,skipExits:true});}
    await automatedOrders(store,fresh,options);
   }
   if(marketUnavailable){await emit(store,'SCAN','Consultas de mercado en espera; se reanudan en el siguiente ciclo');break;}
  }
  if(!options.skipExits&&await store.setting('trading_enabled')){
   const runs=await store.all("SELECT * FROM runs WHERE status IN ('RUNNING','LOSS_LIMIT') AND mode='PAPER'");for(const run of runs)await paperTick(store,run,[],{...options,exitsOnly:true});
  }
  if(!options.skipReconcile)await new ExecutionEngine(store,options).reconcile();
  const tick={at:Date.now(),duration_ms:Date.now()-started,tokens_processed:processed,signals:signals.length,rejected,discovery:'Filtered on-chain pool streams + indexed profiles + rotating tracked tokens'};await store.set('scanner_last_tick',tick);await emit(store,'SCAN','Ciclo completado',tick);return {status:'FINISHED',processed,signals:signals.length,rejected,duration_ms:tick.duration_ms};
 }finally{await store.run("DELETE FROM settings WHERE key='scanner_lease' AND json_extract(value,'$.owner')=?",owner);}
}
