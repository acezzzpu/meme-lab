import {buildShadowUnsigned,ShadowReadBudget} from './shadow-compare.mjs';
import {decode,cleanError} from '../../core/copy/common.mjs';

// Explicit, bounded research on an existing real event. Never changes the
// production FIRST_POLICY_COMPATIBLE selection or the PAPER fill.
export async function benchmarkQuoteRoutes(e){
 const row=await e.store.get("SELECT * FROM copy_actions WHERE mode='PAPER' AND state='FILLED' ORDER BY created_at DESC LIMIT 1");
 if(!row)throw Error('NO_PAPER_EVENT_FOR_ROUTE_RESEARCH');
 const a=decode(row.data),event=a.event,c=await e.store.setting('copy_config'),q=a.quote;
 e.shadowBudget??=new ShadowReadBudget();
 const request={side:row.side,token:row.token,amount:q.amount_raw,slippageBps:c.max_slippage_bps,taker:'0x00000000000000000000000000000000b0bc0f56',paper:true,hints:event.pools??[],candidatePools:event.candidate_pools??[]};
 const candidates=e.routes.providers.filter(p=>['PANCAKE_V2','PANCAKE_SMART','PAPER_DEX_PATH','FLAP_PORTAL'].includes(p.id));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('ROUTE_RESEARCH_DEADLINE')),4000),start=performance.now(),startedAt=Date.now();
 const rows=await Promise.all(candidates.map(async p=>{
  const begin=performance.now(),at=Date.now();
  try{
   const quote=await e.rpc.withContext({signal:controller.signal,priority:-1,pipeline:'ROUTE_RESEARCH',beforeRequest:()=>e.shadowBudget.take()},()=>p.quote({...request,signal:controller.signal}));
   let buildable=false,buildError=null;try{buildShadowUnsigned(quote,c);buildable=true;}catch(error){buildError=cleanError(error);}
   return {provider:p.id,quote_start:at,quote_end:Date.now(),quote_ms:performance.now()-begin,completion_ms:performance.now()-start,expected_output_raw:quote.out_raw,minimum_output_raw:quote.min_out_raw,gas_estimate:quote.estimated_gas,gas_estimate_source:quote.gas_estimate_source,price_impact:quote.impact_pct,route:quote.route,status:'QUOTED',unsigned_buildable:buildable,build_error:buildError,simulation:'NOT_PERFORMED_IN_QUOTE_BENCHMARK',quote};
  }catch(error){return {provider:p.id,quote_start:at,quote_end:Date.now(),quote_ms:performance.now()-begin,status:'FAILED',error:cleanError(error)};}
 }));clearTimeout(timer);
 const valid=rows.filter(r=>r.status==='QUOTED'),fastest=[...valid].sort((a,b)=>a.completion_ms-b.completion_ms)[0],best=[...valid].sort((a,b)=>BigInt(a.expected_output_raw)>BigInt(b.expected_output_raw)?-1:1)[0];
 const evidence={source:'RENDER_CURRENT_QUOTES_FOR_STORED_REAL_EVENT; NOT_A_NEW_LIVE_SAMPLE',target_hash:event.hash,side:row.side,token:row.token,amount_raw:q.amount_raw,at:Date.now(),started_at:startedAt,latency_budget_ms:4000,extra_reads_per_minute_cap:12,rows,fastest_returned_quote:fastest?.provider??null,best_returned_quote:best?.provider??null,fastest_executable_quote:null,best_executable_quote:null,executable_status:'Requires successful simulation of each exact quote; buildable/indicative quotes alone are not executable proof',production_selection_changed:false};
 await e.store.set('copy_route_research',evidence);return evidence;
}
