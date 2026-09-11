import {BSC} from './common.mjs';
const raw=x=>BigInt(x??0),sum=(rows,fn)=>rows.reduce((s,r)=>s+raw(fn(r)),0n),pct=(a,b)=>b>0n?Number(a)*100/Number(b):null;
const gas=t=>t.raw?.receipt?.gasUsed&&t.raw.receipt.effectiveGasPrice?raw(t.raw.receipt.gasUsed)*raw(t.raw.receipt.effectiveGasPrice):t.gas_raw!=null?raw(t.gas_raw):null;
const price=(amount,qty)=>raw(qty)>0n?Number(amount)/Number(qty):null;
// Snapshot analysis of recorded execution evidence only; no network or ledger
// mutations. A partial observation is never promoted to a complete target cycle.
export function copyDegradation(records){
 const groups=new Map(),closed=[],incomplete=[],individual=[];
 for(const r of [...records].sort((a,b)=>a.target.block-b.target.block||(a.target.tx_index??0)-(b.target.tx_index??0))){
  const t=r.target;if(!['BUY','SELL'].includes(t.side)||!t.token||!t.quantity_raw)continue;
  const f=r.action?.fill,entry=t.side==='BUY',tp=t.quote_token===BSC.wbnb?price(t.quote_raw,t.quantity_raw):null,pp=f?price(entry?f.input_raw:f.output_raw,entry?f.output_raw:f.input_raw):null;
  const item={hash:t.hash,token:t.token,side:t.side,target_price_bnb_per_raw_token:tp,paper_price_bnb_per_raw_token:pp,price_gap_pct:tp&&pp?(pp/tp-1)*100:null,price_gap_sign:'PAPER_PRICE / TARGET_PRICE - 1; positive entry or negative exit is worse',quote_delay_ms:r.profile?.stages?.QUOTE??r.action?.quote?.quote_ms??null,target_gas_raw:gas(t)?.toString()??null,paper_gas_raw:f?.fee_raw??null,target_protocol_fee_raw:t.flap?.event_fee_raw??null,target_price_estimate:t.quote_estimate??null,paper_status:r.state??null};individual.push(item);
  const key=(r.target_id??'')+':'+t.token;let g=groups.get(key);if(!g){g={token:t.token,target_id:r.target_id,rows:[],balance:0n,complete_start:t.side==='BUY',reasons:[]};groups.set(key,g);}
  if(t.target_balance_before!=null&&raw(t.target_balance_before)!==g.balance){g.complete_start=false;g.reasons.push('OBSERVED_TARGET_BALANCE_DOES_NOT_MATCH_COLLECTED_TRADES');}
  g.rows.push({...r,metric:item});g.balance+=raw(t.quantity_raw)*(entry?1n:-1n);
  if(!entry&&(t.full_exit||t.target_balance_before!=null&&raw(t.target_balance_before)===raw(t.quantity_raw))){
   const buys=g.rows.filter(x=>x.target.side==='BUY'),sells=g.rows.filter(x=>x.target.side==='SELL'),input=sum(buys,x=>x.target.quote_raw),output=sum(sells,x=>x.target.quote_raw),targetGas=sum(g.rows,x=>gas(x.target));
   const comparable=g.complete_start&&g.balance===0n&&buys.length>0&&g.rows.every(x=>x.target.quote_token===BSC.wbnb&&x.target.quote_raw!=null);
   const fills=g.rows.filter(x=>x.state==='FILLED'&&x.action?.fill),pi=sum(fills.filter(x=>x.target.side==='BUY'),x=>x.action.fill.input_raw),po=sum(fills.filter(x=>x.target.side==='SELL'),x=>x.action.fill.output_raw),pf=sum(fills,x=>x.action.fill.fee_raw),paperTokens=sum(fills,x=>x.target.side==='BUY'?raw(x.action.fill.output_raw):-raw(x.action.fill.input_raw));
   const targetReturn=comparable&&g.rows.every(x=>gas(x.target)!==null)?pct(output-input-targetGas,input):null,paperReturn=pi>0n&&paperTokens===0n?pct(po-pi-pf,pi):null;
   const out={token:g.token,target_id:g.target_id,first_hash:g.rows[0].target.hash,exit_hash:t.hash,hashes:g.rows.map(x=>x.target.hash),buy_count:buys.length,sell_count:sells.length,target_complete:comparable,coverage_reasons:[...new Set(g.reasons)],target_input_raw:input.toString(),target_output_raw:output.toString(),target_gas_raw:targetGas.toString(),target_return_pct:targetReturn,target_return_classification:targetReturn===null?'UNKNOWN':g.rows.some(x=>x.target.quote_estimate)?'ESTIMATED_GROSS_NATIVE_ATTRIBUTION':'DERIVED_FROM_RECORDED_AMOUNTS',paper_input_raw:pi.toString(),paper_output_raw:po.toString(),paper_gas_raw:pf.toString(),paper_remaining_raw:paperTokens.toString(),paper_return_pct:paperReturn,difference_pp:targetReturn!==null&&paperReturn!==null?paperReturn-targetReturn:null,paper_classification:'VIRTUAL_ESTIMATED_FILLS',entry_price_gaps:g.rows.filter(x=>x.target.side==='BUY').map(x=>x.metric),exit_price_gaps:g.rows.filter(x=>x.target.side==='SELL').map(x=>x.metric),quote_delays_ms:g.rows.map(x=>x.metric.quote_delay_ms),fees_note:'PAPER fee_raw and target receipt gas included once. Pool fees/taxes embedded in execution prices; unresolved native router refunds/fees remain explicitly estimated.'};
   (comparable?closed:incomplete).push(out);groups.delete(key);
  }
 }
 return {source:'PERSISTED_TARGET_EVENTS_AND_PAPER_FILLS',at:Date.now(),completed_cycles:closed,incomplete_closed_cycles:incomplete,open_observed_cycles:[...groups.values()].map(g=>({token:g.token,hashes:g.rows.map(x=>x.target.hash),observed_balance_raw:g.balance.toString(),complete_start:g.complete_start})),trades:individual,causal_limit:'Price gaps combine price movement, route selection, token fees, sizing and delay. These records do not isolate each cause.'};
}
