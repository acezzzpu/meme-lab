// A known curve gets a bounded head start, not an entire serial timeout.
export function hedgeKnownRoute(providers,id,delayMs=250){
 const preferred=providers.find(p=>p.id===id);if(!preferred)return providers;
 let release;const failed=new Promise(r=>release=r);
 return providers.map(p=>p===preferred?{id:p.id,quote:async r=>{try{return await p.quote(r);}catch(e){release();throw e;}}}:{id:p.id,authenticatesObservedPools:p.authenticatesObservedPools,quote:async r=>{
  await new Promise((resolve,reject)=>{let timer;const cleanup=()=>{clearTimeout(timer);r.signal?.removeEventListener('abort',abort);};const done=()=>{cleanup();resolve();};const abort=()=>{cleanup();reject(r.signal.reason);};if(r.signal?.aborted)return abort();r.signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(done,delayMs);failed.then(done);});
  r.signal?.throwIfAborted();return p.quote(r);
 }});
}
