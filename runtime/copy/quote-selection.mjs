import {check,cleanError} from '../../core/copy/common.mjs';

// Return the first policy-compatible quote. Cancel slower work instead of waiting
// for every adapter. This deliberately does not claim the best possible price.
export async function selectQuote(providers,request,{rpc,live=false,priority=0,validate=q=>q,onQuote=async()=>{},deadlineAt=Date.now()+4000}={}){
 const controllers=providers.map(()=>new AbortController()),attempts=providers.map(p=>({provider:p.id,status:'PENDING'}));
 let timer,finished=false,remaining=providers.length;
 const snapshot=reason=>attempts.map(a=>({...a,status:a.status==='PENDING'||a.status==='QUOTED'?reason:a.status}));
 return new Promise((resolve,reject)=>{
  const cancel=()=>controllers.forEach(c=>c.abort(Error('QUOTE_SELECTION_FINISHED')));
  const fail=reason=>{if(finished)return;finished=true;clearTimeout(timer);const error=Error(reason);error.route_errors=snapshot(reason==='ROUTE_QUOTE_TIMEOUT'?'TIMED_OUT':'ERROR');cancel();reject(error);};
  if(deadlineAt<=Date.now())return fail('SIGNAL_EXPIRED');if(!providers.length)return fail('NO_EXECUTABLE_ROUTE');
  timer=setTimeout(()=>fail('ROUTE_QUOTE_TIMEOUT'),Math.max(1,deadlineAt-Date.now()));
  providers.forEach((provider,i)=>{
   const run=async()=>{
    const q=await provider.quote({...request,signal:controllers[i].signal});if(finished)return;
    attempts[i]={provider:provider.id,status:'QUOTED',out_raw:q.out_raw,fee_raw:q.fee_raw,quote_ms:q.quote_ms,impact_pct:q.impact_pct};
    await onQuote(q);if(finished)return;
    check(Number.isFinite(q.impact_pct),'IMPACT_UNKNOWN');check(!live||['PANCAKE_V2','PANCAKE_SMART'].includes(q.provider),'ROUTE_NOT_LIVE_VALIDATED');
    const eligible=await validate(q);if(finished)return;check(eligible,'ROUTE_POLICY_REJECTED');
    check(Date.now()<deadlineAt,'SIGNAL_EXPIRED');attempts[i].status='ELIGIBLE';finished=true;clearTimeout(timer);
    const evidence=snapshot('CANCELLED_AFTER_SELECTION');cancel();resolve({...eligible,selection:'FIRST_POLICY_COMPATIBLE',route_comparison:evidence,route_errors:evidence.filter(a=>a.status==='ERROR'||a.status==='INELIGIBLE')});
   };
   Promise.resolve().then(()=>rpc?.withContext?rpc.withContext({signal:controllers[i].signal,priority},run):run()).catch(error=>{
    if(finished)return;attempts[i]={...attempts[i],status:attempts[i].status==='QUOTED'?'INELIGIBLE':'ERROR',error:cleanError(error)};
   }).finally(()=>{remaining--;if(!remaining&&!finished)fail('NO_EXECUTABLE_ROUTE');});
  });
 });
}
