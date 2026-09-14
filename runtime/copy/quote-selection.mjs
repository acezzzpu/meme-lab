import {QuoteTrace} from './quote-profile.mjs';
import {check,cleanError} from '../../core/copy/common.mjs';

export function candidatePriority(provider,request,priority){
 // Render's 3237 ms PAPER_DEX_PATH quote competed with 12 speculative V3
 // discovery reads that found no route. Keep those reads running, but reserve
 // urgent slots for the actual receipt's candidate pool authentication.
 const speculative=request.paper&&!provider.authenticatesObservedPools&&provider.id==='PANCAKE_SMART'&&request.candidatePools?.length&&!request.hints?.some(h=>h.token0&&h.token1);
 return speculative?Math.min(-1,priority):priority;
}

// Return the first policy-compatible quote. Cancel slower work instead of waiting
// for every adapter. This deliberately does not claim the best possible price.
export async function selectQuote(providers,request,{rpc,live=false,priority=0,allowUnknownImpact=false,validate=q=>q,onQuote=async()=>{},deadlineAt=Date.now()+4000,routeTimeoutMs=2500}={}){
 const controllers=providers.map(()=>new AbortController()),attempts=providers.map(p=>({provider:p.id,status:'PENDING'}));
 let timer,finished=false,remaining=providers.length;
 const traces=providers.map(p=>new QuoteTrace(p.id));
 const snapshot=reason=>attempts.map((a,i)=>({...a,quote_profile:traces[i].snapshot(),status:a.status==='PENDING'||a.status==='QUOTED'?reason:a.status}));
 return new Promise((resolve,reject)=>{
  const cancel=()=>controllers.forEach(c=>c.abort(Error('QUOTE_SELECTION_FINISHED')));
  const fail=reason=>{if(finished)return;finished=true;clearTimeout(timer);const error=Error(reason);error.route_errors=snapshot(reason==='ROUTE_QUOTE_TIMEOUT'?'TIMED_OUT':'ERROR');cancel();reject(error);};
  if(deadlineAt<=Date.now())return fail('SIGNAL_EXPIRED');if(!providers.length)return fail('NO_EXECUTABLE_ROUTE');
  timer=setTimeout(()=>fail('ROUTE_QUOTE_TIMEOUT'),Math.max(1,deadlineAt-Date.now()));
  providers.forEach((provider,i)=>{
   const run=async()=>{
    const started=performance.now();attempts[i].quote_start=Date.now();
    const work=()=>provider.quote({...request,signal:controllers[i].signal});let raw,routeTimer;try{raw=await Promise.race([(rpc?.withContext?rpc.withContext({quoteTrace:traces[i]},work):work()),new Promise((_,reject)=>{routeTimer=setTimeout(()=>{const e=Error('PER_ROUTE_QUOTE_TIMEOUT');controllers[i].abort(e);reject(e);},Math.max(1,Math.min(provider.id==='PANCAKE_FLAP_ATOMIC'?6000:routeTimeoutMs,deadlineAt-Date.now())));})]);}finally{clearTimeout(routeTimer);traces[i].finished=performance.now();}const q={...raw,quote_profile:traces[i].snapshot()};if(finished)return;
    attempts[i]={...attempts[i],provider:provider.id,status:'QUOTED',quote_end:Date.now(),measured_quote_ms:performance.now()-started,out_raw:q.out_raw,fee_raw:q.fee_raw,quote_ms:q.quote_ms,impact_pct:q.impact_pct};
    await onQuote(q);if(finished)return;
    if(live||!allowUnknownImpact)check(Number.isFinite(q.impact_pct),'IMPACT_UNKNOWN');check(!live||['PANCAKE_V2','PANCAKE_SMART'].includes(q.provider),'ROUTE_NOT_LIVE_VALIDATED');
    const eligible=await validate(q);if(finished)return;check(eligible,'ROUTE_POLICY_REJECTED');
    check(Date.now()<deadlineAt,'SIGNAL_EXPIRED');attempts[i].status='ELIGIBLE';finished=true;clearTimeout(timer);
    const evidence=snapshot('CANCELLED_AFTER_SELECTION');cancel();resolve({...eligible,selection:'FIRST_POLICY_COMPATIBLE',route_comparison:evidence,route_errors:evidence.filter(a=>a.status==='ERROR'||a.status==='INELIGIBLE')});
   };
   Promise.resolve().then(()=>rpc?.withContext?rpc.withContext({signal:controllers[i].signal,priority:candidatePriority(provider,request,priority)},run):run()).catch(error=>{
    if(finished)return;attempts[i]={...attempts[i],status:attempts[i].status==='QUOTED'?'INELIGIBLE':'ERROR',error:cleanError(error),quote_end:Date.now()};
   }).finally(()=>{remaining--;if(!remaining&&!finished)fail('NO_EXECUTABLE_ROUTE');});
  });
 });
}
