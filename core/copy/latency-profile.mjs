import {BSC,decode,encode} from './common.mjs';

export const STAGES=['PENDING_DETECTION','BLOCK_DETECTION','TX_FETCH','RECEIPT','DECODE','POSITION_STATE','QUOTE_FIRST_RESPONSE','QUOTE','ROUTE_SELECTION','PAPER_EXECUTION','SHADOW_BUILD','SIMULATION','TOTAL_PAPER_REACTION','TOTAL_SHADOW_REACTION'];
export function measuredQuantiles(values,{allowNegative=false}={}){
 const a=values.filter(v=>Number.isFinite(v)&&(allowNegative||v>=0)).sort((a,b)=>a-b),n=a.length;
 const q=p=>a[Math.ceil(p*n)-1];
 return {n,min_ms:n?a[0]:null,max_ms:n?a.at(-1):null,p50_ms:n>=2?q(.5):null,p95_ms:n>=20?q(.95):null,p99_ms:n>=100?q(.99):null,precision:'EMPIRICAL_NEAREST_RANK',insufficient_for:n<2?['P50','P95','P99']:n<20?['P95','P99']:n<100?['P99']:[]};
}
// Additive diagnostics only. A diagnostics failure must never reject a PAPER fill.
export async function saveProfile(store,eventId,patch){
 try{await store.run('INSERT INTO copy_latency_profiles(event_id,first_seen_at,updated_at,data) VALUES (?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET data=json_patch(copy_latency_profiles.data,excluded.data),updated_at=excluded.updated_at',eventId,patch.wall?.target_first_seen_at??Date.now(),Date.now(),encode(patch));return true;}
 catch{return false;}
}
export function observationProfile(e,p,event,intent,stageMs){
 const same=p.clock_boot===e.boot,headMono=same&&Number.isFinite(p.head_received_mono)?p.head_received_mono:null;
 const pendingSame=intent.clock_boot===e.boot&&Number.isFinite(intent.pending_received_mono);
 // Require an actual pending message BEFORE our first observation of the head.
 // This is a local observation advantage, not a cross-clock inclusion estimate.
 const pendingBeforeHead=pendingSame&&headMono!==null&&intent.pending_received_mono<headMono;
 const origin=e.eventClocks?.get(p.hash),source=pendingBeforeHead?'PENDING_MEMPOOL':'BLOCK';
 return {version:1,event_id:p.target+':'+p.hash,target_hash:p.hash,target_id:p.target,token:event.token,side:event.side,kind:event.kind,block:event.block,history:!!p.history,boot:e.boot,detection_source:source,pending_observed:!!intent.pending_received_at,pending_before_head:pendingBeforeHead,pending_advantage_ms:pendingBeforeHead?headMono-intent.pending_received_mono:null,clock:'MONOTONIC_LOCAL',network_propagation_ms:null,tx_fetch_source:p.tx?'FULL_BLOCK_PAYLOAD':'HTTP',wall:{target_first_seen_at:origin?.wall??p.received_at,pending_first_seen_at:intent.pending_received_at??null,block_first_seen_at:p.head_received_at??null,target_identified_at:p.received_at,decoded_at:Date.now()},stages:{...stageMs,PENDING_DETECTION:pendingSame?intent.provisional_decode_ms:null,BLOCK_DETECTION:headMono!==null&&Number.isFinite(p.received_mono)?p.received_mono-headMono:null},provisional_signal:intent.side?{side:intent.side,token:intent.token,status:'PROVISIONAL',confirmed:false}:null,canonical_signal:{side:event.side,token:event.token,status:'CONFIRMED'},detection_meaning:'Pending: local provider message to provisional decode. Block: local head arrival to identifying target in full block. Network propagation and actual inclusion delay are unknown.'};
}
export function summarizeProfiles(profiles){
 const live=profiles.filter(p=>!p.history&&p.side&&p.version===1),pending=live.filter(p=>p.pending_before_head),stages={};
 for(const stage of STAGES)stages[stage]=measuredQuantiles(live.map(p=>p.stages?.[stage]));
 return {live_sample_count:live.length,sample_goal:50,stages,pending_capture_rate:live.length?pending.length/live.length:null,pending_capture_numerator:pending.length,pending_capture_denominator:live.length,pending_advantage:measuredQuantiles(pending.map(p=>p.pending_advantage_ms)),block_observed_count:live.filter(p=>p.wall?.block_first_seen_at).length,block_capture_rate:null,block_capture_rate_requires:'Independent nonce audit; share of BLOCK rows is not capture completeness',clock:'MONOTONIC_LOCAL',statistics_note:'P50 requires 2 observations, P95 20, P99 100. Samples are empirical, not a guarantee; stages can overlap.',source_breakdown:{PENDING_MEMPOOL:pending.length,BLOCK:live.length-pending.length}};
}
export async function latencyProfileSummary(store){
 const rows=await store.all("SELECT p.data,e.data target_data,a.data action_data,a.state,a.error,l.pnl_raw,l.fee_raw FROM copy_latency_profiles p LEFT JOIN copy_events e ON e.id=p.event_id LEFT JOIN copy_actions a ON a.event_id=p.event_id AND a.mode='PAPER' LEFT JOIN copy_ledger l ON l.action_id=a.id ORDER BY p.first_seen_at");
 const profiles=rows.map(r=>{const p=decode(r.data),t=decode(r.target_data),a=decode(r.action_data);return {...p,comparison:compareTrade(p,t,a,r)};});
 return {...summarizeProfiles(profiles),copyability:{paper_realized_pnl_raw:rows.filter(r=>r.pnl_raw!=null).reduce((s,r)=>s+BigInt(r.pnl_raw),0n).toString(),target_pnl:null,shadow_expected_pnl:null,reason:'Target and SHADOW cycle results require complete comparable inventory and verified proceeds; individual quotes do not establish returns',price_disadvantage:measuredQuantiles(profiles.map(p=>p.comparison.price_disadvantage_pct),{allowNegative:true}),price_gap_signed_samples:profiles.filter(p=>p.comparison.price_disadvantage_pct!==null).length},records:profiles.slice(-100)};
}

export function compareTrade(profile,target,action,ledger={}){
 const native=target.quote_token===BSC.wbnb,knownDecimals=Number.isInteger(target.decimals),tp=native&&knownDecimals&&target.quote_raw&&target.quantity_raw?Number(target.quote_raw)/1e18/(Number(target.quantity_raw)/10**target.decimals):null;
 const fill=action.fill,pp=fill&&knownDecimals?(profile.side==='BUY'?Number(fill.input_raw)/1e18/(Number(fill.output_raw)/10**target.decimals):Number(fill.output_raw)/1e18/(Number(fill.input_raw)/10**target.decimals)):null;
 const sh=profile.shadow,sp=sh?.quote&&knownDecimals?(profile.side==='BUY'?Number(sh.quote.amount_raw)/1e18/(Number(sh.quote.min_out_raw)/10**target.decimals):Number(sh.quote.min_out_raw)/1e18/(Number(sh.quote.amount_raw)/10**target.decimals)):null;
 const gap=tp&&pp?(profile.side==='BUY'?pp/tp-1:1-pp/tp)*100:null;
 return {target_tx:profile.target_hash,side:profile.side,token:profile.token,detection_source:profile.detection_source,target_execution_price_bnb:tp,target_price_classification:tp===null?'UNKNOWN':target.quote_estimate?'ESTIMATED':'DERIVED',target_return:null,paper_fill_price_bnb:pp,paper_classification:'ESTIMATED_VIRTUAL_FILL',paper_pnl_raw:ledger.pnl_raw??null,paper_status:ledger.state??profile.paper?.status??null,paper_error:ledger.error??profile.paper?.error??null,shadow_quote_price_bnb:sp,shadow_classification:'ESTIMATED_CURRENT_QUOTE',shadow_expected_return:null,price_disadvantage_pct:Number.isFinite(gap)?gap:null,price_gap_classification:tp===null||pp===null?'UNKNOWN':'ESTIMATED',target_gas_raw:target.gas_raw??null,paper_gas_raw:ledger.fee_raw??null,shadow_gas_raw:sh?.expected_gas_fee_raw??null,slippage_bps:action.quote?.slippage_bps??null,price_impact_pct:action.quote?.impact_pct??null,target_exit_fraction:target.sold_fraction??null,target_exit_fraction_classification:target.field_evidence?.sold_fraction??'UNKNOWN',paper_exit_amount_raw:profile.side==='SELL'?fill?.input_raw??null:null,total_paper_reaction_ms:profile.stages?.TOTAL_PAPER_REACTION??null,total_shadow_reaction_ms:profile.stages?.TOTAL_SHADOW_REACTION??null,shadow_status:sh?.status??'NOT_ATTEMPTED',simulation_status:sh?.simulation?.status??'NOT_ATTEMPTED',unsigned_tx_built:sh?.unsigned_tx_built??false};
}
