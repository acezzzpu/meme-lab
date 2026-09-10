import {DexScreenerProvider,recordMarketError} from './providers/market.mjs';
import {SOL,USDC} from './providers/chains.mjs';
import {paperTick} from './paper.mjs';
import {ExecutionEngine} from './execution/engine.mjs';
import {emit} from './engine-state.mjs';
import {safeError,json} from './util.mjs';
export async function monitorPaperPositions(store,options){
 if(!await store.setting('trading_enabled'))return;
 const runs=await store.all("SELECT * FROM runs WHERE mode='PAPER' AND status IN ('RUNNING','LOSS_LIMIT')"),market=new DexScreenerProvider();
 if(!runs.length)return;
 // Keep funding fresh even after the last position closes; discovery is independent.
 try{const stable=await store.get('SELECT received_at FROM market_snapshots WHERE token_id=? ORDER BY received_at DESC LIMIT 1','solana:'+USDC);if(!stable||Date.now()-stable.received_at>15000)await market.record(store,'solana',USDC);}
 catch(e){await recordMarketError(store,e);const previous=await store.setting('paper_price_warning')??0;if(Date.now()-previous>=30000){await store.set('paper_price_warning',Date.now());await emit(store,'RISK','PAPER espera datos de mercado: precio de USDC no disponible',{error:safeError(e),retry_at:e.retryAt??null},'solana');}return;}
 for(const run of runs){const positions=await store.all('SELECT p.id,t.address,t.chain FROM positions p JOIN tokens t ON t.id=p.token_id WHERE p.run_id=? AND p.closed_at IS NULL',run.id);
  const cursor=await store.setting('exit_cursor:'+run.id)??0;const selected=positions.length?[...positions.slice(cursor%positions.length),...positions.slice(0,cursor%positions.length)].slice(0,2):[];await store.set('exit_cursor:'+run.id,positions.length?(cursor+selected.length)%positions.length:0);
  for(const p of selected){try{
   const stable=await store.get('SELECT received_at FROM market_snapshots WHERE token_id=? ORDER BY received_at DESC LIMIT 1','solana:'+USDC);if(!stable||Date.now()-stable.received_at>20000)await market.record(store,'solana',USDC);
   await market.record(store,p.chain,p.address);await paperTick(store,run,[],{...options,exitsOnly:true,exitPositionId:p.id});
  }catch(e){await emit(store,'ERROR','No se pudo vigilar una salida PAPER',{position_id:p.id,error:safeError(e)},p.chain,p.id);}}
 }
}
export async function reconcileWithPrices(store,options){
 const pending=await store.all("SELECT chain,input_mint,output_mint,build FROM orders WHERE state IN ('SUBMITTED','SUBMISSION_UNKNOWN','BROADCAST_PENDING','CONFIRMED','RECONCILING') LIMIT 10");
 const assets=new Map();for(const o of pending)for(const address of [o.input_mint,o.output_mint,json(o.build)?.feeAsset])if(address)assets.set(o.chain+':'+address,{chain:o.chain,address});
 const market=new DexScreenerProvider();for(const [tokenId,asset] of assets){const m=await store.get('SELECT received_at FROM market_snapshots WHERE token_id=? ORDER BY received_at DESC LIMIT 1',tokenId);if(!m||Date.now()-m.received_at>60000){try{await market.record(store,asset.chain,asset.address);}catch(e){await emit(store,'ERROR','Valoración pendiente para reconciliación',{token_id:tokenId,error:safeError(e)},asset.chain);}}}
 await new ExecutionEngine(store,options).reconcile();
}
