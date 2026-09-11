import {assertCopyFence,calculateSize,applyFill} from '../../core/copy/execution-policy.mjs';
import {account} from '../../core/copy/service.mjs';
import {BSC,check,decode,encode,cleanError,bucket} from '../../core/copy/common.mjs';
import {applyTaxes} from './safety.mjs';

// PAPER is an audited virtual ledger. It never builds approvals, asks a signer,
// sends a transaction, or interprets a simulated fill as an on-chain execution.
export async function processPaperAction(e,action){
 let data=decode(action.data);const start=performance.now(),attempts=[];
 try{
  const {config:c,target:tc,event}=await assertCopyFence(e.store,action,{paperResearch:true});
  const usd=tc.size_mode==='FIXED_USD'?await e.freshPrice():null;
  const amount=await calculateSize(e.store,action.mode,tc,action.target_id,event,c,usd);check(amount>0n,'ZERO_COPY_AMOUNT');
  const position=await e.store.get('SELECT data FROM copy_positions WHERE target_id=? AND token=? AND mode=? AND closed_at IS NULL',action.target_id,event.token,bucket(action.mode));
  const cash=await account(e.store,action.mode,c);check(action.side!=='BUY'||cash.cash-cash.reserved>=amount,'PAPER_BALANCE_INSUFFICIENT');
  const times={...(event.timings??{}),quotes_started_at:Date.now()};let firstQuoteMono=null;
  const cachedSafety=e.safety?.cache?.get(event.token);
  let safetyResult=cachedSafety;
  // Safety enrichment runs independently. Unknown tax is shown as an explicit
  // model limitation, never transformed into verified zero tax or LIVE approval.
  e.safety?.inspect(event.token).then(async safety=>{safetyResult=safety;data.safety=safety;await e.store.run("UPDATE copy_actions SET data=json_set(data,'$.safety',json(?)) WHERE id=?",encode(safety),action.id);}).catch(()=>{});
  const validate=raw=>{
   const taxes=raw.token_metadata?.[action.side==='BUY'?'buyToken':'sellToken'];
   const bps=taxes?.[action.side==='BUY'?'buyTaxBps':'sellTaxBps']??raw.portal_state?.[action.side==='BUY'?'buy_tax_bps':'sell_tax_bps'];
   const knownTax=bps!==null&&bps!==undefined&&/^\d+$/.test(String(bps))&&Number(bps)<=10000?Number(bps)/10000:null;
   const q=applyTaxes(raw,safetyResult??{buy_tax:null,sell_tax:null});
   check(BigInt(q.min_out_raw)>0n&&BigInt(q.out_raw)>=BigInt(q.min_out_raw),'PAPER_INVALID_QUOTE');
   check(Date.now()-q.quoted_at<=c.max_quote_age_ms,'QUOTE_EXPIRED');
   check(Number(q.slippage_bps)<=c.max_slippage_bps,'SLIPPAGE_LIMIT');
   check(cash.cash-cash.reserved>=(action.side==='BUY'?amount:0n)+BigInt(q.fee_raw),'PAPER_BALANCE_INSUFFICIENT');
   if(data.approved_intent)check(data.approved_intent.provider===q.provider&&BigInt(q.min_out_raw)>=BigInt(data.approved_intent.min_out_raw),'APPROVED_TERMS_CHANGED');
   const tax=knownTax??safetyResult?.[action.side==='BUY'?'buy_tax':'sell_tax']??null;
   return {...q,tax_classification:tax===null?'UNKNOWN_TAX':tax>0?'BUY_SELL_TAX':'NORMAL_TOKEN',tax_rate:tax};
  };
  await e.updateAction(action,'PROCESSING',data,null,{amount:String(amount)});
  const quoteStart=performance.now();
  const q=await e.routes.quote({side:action.side,token:event.token,amount:String(amount),slippageBps:c.max_slippage_bps,taker:'0x000000000000000000000000000000000000dead',paper:true,prefetchedQuote:e.pendingQuotes?.get(event.hash)?.promise,candidatePools:event.candidate_pools??[],hints:[...(decode(position?.data).pools??[]),...(event.pools??[])]},{live:false,allowUnknownImpact:true,priority:2,deadlineAt:Date.now()+8000,validate,onQuote:async q=>{if(firstQuoteMono===null){firstQuoteMono=performance.now();times.first_quote_at=Date.now();times.first_quote_received_at=times.first_quote_at;}attempts.push({provider:q.provider,quoted_at:q.quoted_at,out_raw:q.out_raw,quote_ms:q.quote_ms});}});
  times.selected_quote_at=Date.now();const quoteMs=performance.now()-quoteStart;
  const available=await account(e.store,action.mode,c),fee=BigInt(q.fee_raw);check(available.cash-available.reserved>=(action.side==='BUY'?amount:0n)+fee,'PAPER_BALANCE_INSUFFICIENT');
  await assertCopyFence(e.store,action,{paperResearch:true});
  const price=Number.isInteger(event.decimals)?(action.side==='BUY'?Number(amount)/1e18/(Number(q.min_out_raw)/10**event.decimals):Number(q.min_out_raw)/1e18/(Number(amount)/10**event.decimals)):null;
  const late=event.history||Date.now()-(event.detected_at??Date.now())>tc.max_signal_age_ms;
  data={...data,event,quote:q,copy_status:'PAPER_'+action.side+'_EXECUTED',execution_success:true,detection_success:true,route_errors:q.route_errors??[],quote_attempts:attempts,timings:times,paper_model:{source:'OWN_CURRENT_ROUTE_QUOTE',output:'MINIMUM_QUOTED_OUTPUT',gas:'ESTIMATED',tax:q.tax_classification,atomic_execution_verified:false,route_limitation:q.live_block??null,sell_sizing:'EXACT_RAW_PROPORTION_FLOORED',unknown_tax_assumption:q.tax_classification==='UNKNOWN_TAX'?'Quoted output does not establish actual proceeds after unknown transfer taxes':null,historical:!!event.history,late_research:!!late,not_an_onchain_fill:true},comparison:{our_price_bnb:price,target_price_bnb:event.price_quote??null,price_gap_pct:price&&event.price_quote?(price/event.price_quote-1)*100:null},quote_ms:quoteMs};
  await e.updateAction(action,'PROCESSING',data,null,{amount:String(amount)});action.data=encode(data);
  check(await applyFill(e.store,action,{inputRaw:String(amount),outputRaw:q.min_out_raw,feeRaw:q.fee_raw,markPrice:price}),'COPY_STOPPED_BEFORE_FILL');
  times.paper_fill_at=Date.now();times.paper_execution_at=times.paper_fill_at;const fillMono=performance.now(),processMs=fillMono-start;
  await e.store.run("UPDATE copy_actions SET data=json_set(data,'$.timings',json(?),'$.paper_process_ms',?) WHERE id=?",encode(times),processMs,action.id);
  await e.sample('QUOTE_MS',quoteMs,action.event_id,q.provider,{clock:'MONOTONIC_LOCAL',historical:!!event.history});
  await e.sample('PAPER_PROCESS_MS',processMs,action.event_id,'PAPER',{clock:'MONOTONIC_LOCAL',historical:!!event.history});
  const origin=e.eventClocks?.get(event.hash);if(origin?.boot===e.boot){const reaction=fillMono-origin.mono;if(!event.history)await e.store.run("UPDATE copy_actions SET data=json_set(data,'$.paper_reaction_ms',?) WHERE id=?",reaction,action.id);await e.sample(event.history?'HISTORICAL_RESEARCH_MS':'PAPER_REACTION_MS',reaction,action.event_id,'PAPER',{clock:'MONOTONIC_LOCAL',first_seen_at:origin.wall});if(!event.history)await e.sample('TOTAL_COPY_REACTION_MS',reaction,action.event_id,'PAPER',{clock:'MONOTONIC_LOCAL',first_seen_at:origin.wall});}
  await e.report('FILL',`${event.history?'HISTORICAL RESEARCH · ':''}PAPER ${action.side}`,{action_id:action.id,target_hash:event.hash,token:event.token,amount_raw:String(amount),output_raw:q.min_out_raw,quote_ms:quoteMs,process_ms:processMs,tax:q.tax_classification});
 }catch(error){
  const row=await e.store.get('SELECT * FROM copy_actions WHERE id=?',action.id);if(!row||['FILLED','CANCELLED'].includes(row.state))return;
  await e.updateAction(row,'REJECTED',{...data,quote_attempts:attempts,route_errors:error.route_errors??[],detection_success:true,execution_success:false,copy_status:cleanError(error).includes('ROUTE')?'NO_EXECUTABLE_ROUTE':'PAPER_COPY_FAILED'},cleanError(error),{reserved:'0'});
  await e.report('REJECT','PAPER '+cleanError(error),{action_id:action.id,target_hash:data.event?.hash});
 }
}
