import {decode,encode} from './common.mjs';

export const STAGES=['PENDING_DETECTION','BLOCK_DETECTION','TX_FETCH','RECEIPT','DECODE','POSITION_STATE','QUOTE_FIRST_RESPONSE','QUOTE','ROUTE_SELECTION','PAPER_EXECUTION','SHADOW_BUILD','SIMULATION','TOTAL_PAPER_REACTION','TOTAL_SHADOW_REACTION'];
export function measuredQuantiles(values){
 const a=values.filter(v=>Number.isFinite(v)&&v>=0).sort((a,b)=>a-b),n=a.length;
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
 const rows=await store.all('SELECT data FROM copy_latency_profiles ORDER BY first_seen_at');
 const profiles=rows.map(r=>decode(r.data));return {...summarizeProfiles(profiles),records:profiles.slice(-100)};
}
