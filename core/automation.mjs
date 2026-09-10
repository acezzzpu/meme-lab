import {ExecutionEngine} from './execution/engine.mjs';
import {USDC} from './providers/chains.mjs';
import {emit} from './engine-state.mjs';
import {json,id,safeError} from './util.mjs';

export async function automatedOrders(store,signals,options={}){
 const mode=await store.setting('mode');if(!['SHADOW','LIVE_APPROVAL'].includes(mode)||!await store.setting('trading_enabled'))return;
 const engine=new ExecutionEngine(store,options),config=await store.setting('automation')??{},wallets=await store.setting('execution_wallets');
 const positions=mode==='LIVE_APPROVAL'?await store.all("SELECT * FROM positions WHERE mode='LIVE_APPROVAL' AND closed_at IS NULL"):[];
 const candidates=[];
 for(const p of positions){
  const v=await store.get('SELECT * FROM strategy_versions WHERE id=?',p.version_id);if(!v)continue;const rules=json(v.parameters),m=await store.get('SELECT * FROM market_snapshots WHERE token_id=? ORDER BY received_at DESC LIMIT 1',p.token_id);
  if(!m?.price||Date.now()-m.received_at>45000)continue;const high=Math.max(p.high_price??p.entry_price,m.price);await store.run('UPDATE positions SET high_price=? WHERE id=?',high,p.id);
  const change=(m.price/p.entry_price-1)*100;const reason=change<=-rules.stop_loss_pct?'STOP_LOSS':change>=rules.take_profit_pct?'TAKE_PROFIT':m.price<=high*(1-rules.trailing_pct/100)?'TRAILING':Date.now()-p.opened_at>=rules.max_hold_minutes*60000?'TIME_EXIT':null;
  if(reason)candidates.push({token_id:p.token_id,version_id:p.version_id,side:'SELL',amount_raw:p.quantity_raw,reason,position:p});
 }
 if(!await store.setting('entries_paused'))for(const s of signals.filter(s=>s.version_id===config.version_id).slice(0,1))candidates.push({...s,side:'BUY',reason:'STRATEGY_SIGNAL'});
 for(const c of candidates){
  const token=await store.get('SELECT * FROM tokens WHERE id=?',c.token_id);if(!token||token.chain!=='solana'){await emit(store,'RISK','Automatización de esta red pendiente; orden no enviada',{token_id:c.token_id});continue;}
  const recent=await store.get("SELECT id FROM orders WHERE token_id=? AND mode=? AND side=? AND (created_at>? OR state IN ('AWAITING_APPROVAL','APPROVED','SIGNED','BROADCAST_PENDING','SUBMITTED','SUBMISSION_UNKNOWN')) LIMIT 1",token.id,mode,c.side,Date.now()-60000);if(recent)continue;
  try{
   if(!wallets[token.chain])throw Error('DEDICATED_WALLET_REQUIRED');
   const stable=await store.get('SELECT * FROM market_snapshots WHERE token_id=? ORDER BY received_at DESC LIMIT 1','solana:'+USDC),market=await store.get('SELECT * FROM market_snapshots WHERE token_id=? ORDER BY received_at DESC LIMIT 1',token.id);
   if(!stable?.price||Date.now()-stable.received_at>45000||token.decimals===null)throw Error('INPUT_PRICE_OR_DECIMALS_UNKNOWN');
   const notional=c.side==='BUY'?config.order_cents:Math.ceil(Number(BigInt(c.amount_raw))/10**token.decimals*market.price*100);
   const amount=c.side==='BUY'?String(Math.floor(notional/100/stable.price*1e6)):c.amount_raw;
   const order=await engine.create({idempotency_key:id(),chain:token.chain,mode,side:c.side,token_id:token.id,version_id:c.version_id,wallet:wallets[token.chain],input_mint:c.side==='BUY'?USDC:token.address,output_mint:c.side==='BUY'?token.address:USDC,amount_raw:amount,notional_cents:notional});
   await store.run('INSERT OR REPLACE INTO order_context VALUES (?,?,?,?,?,?,?,NULL)',order.id,c.id??null,c.score??null,c.reason,market.price,market.market_cap,order.quote?.slippageBps??null);
   await emit(store,'ORDER',mode==='SHADOW'?'SHADOW: simulación registrada':'Orden preparada: requiere aprobación y firma',{order_id:order.id,side:c.side,reason:c.reason,score:c.score??null,state:order.state},token.chain,order.id);
  }catch(e){await emit(store,'RISK',mode+' · orden rechazada',{token_address:token.address,side:c.side,reason:c.reason,error:safeError(e)},token.chain,c.id??c.position?.id);}
 }
}
