// One request budget per provider and process. Never retries a request implicitly:
// broadcasting a signed transaction must remain under the execution state machine.
export function providerPolicy(url){
 const host=new URL(url).hostname;
 if(host==='api.dexscreener.com')return {concurrency:2,spacing:350};
 if(['api.mainnet-beta.solana.com','api.devnet.solana.com','solana-rpc.publicnode.com'].includes(host))return {concurrency:2,spacing:300,transactionSpacing:1100};
 return {concurrency:2,spacing:50};
}
export function retryAfterMs(value,now=Date.now()){
 if(!value)return 0;
 const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;
 const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-now):0;
}
export function createProviderHttp({fetcher=(...args)=>fetch(...args),now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),policy=providerPolicy,timeoutMs=12000}={}){
 const states=new Map();
 const providerHttp=async function(url,options={}){
  const host=new URL(url).hostname;
  let state=states.get(host);if(!state){state={active:0,next:0,transactionNext:0,until:0,reason:null,failures:0,revision:0};states.set(host,state);}
  const limit=policy(url),began=now();
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  let method=null;try{method=JSON.parse(options.body??'null')?.method;}catch{}
  const transaction=method==='getTransaction'&&limit.transactionSpacing;
  const cooling=()=>{if(state.until>now()){const error=Error(`PROVIDER_COOLDOWN ${host} · ${state.reason} · retry_in_ms=${Math.ceil(state.until-now())}`);error.retryAt=state.until;error.provider=host;throw error;}};
  // Wait for capacity, not for an entire provider outage. Durable jobs own retries.
  while(true){
   cooling();
   if(options.signal?.aborted)options.signal.throwIfAborted();
   if(signal.aborted||now()-began>=timeoutMs){const error=Error(`PROVIDER_QUEUE_TIMEOUT ${host}`);error.provider=host;error.retryAt=now()+1000;throw error;}
   const next=Math.max(state.next,transaction?state.transactionNext:0);
   if(state.active<limit.concurrency&&next<=now())break;
   await wait(Math.max(1,Math.min(100,next>now()?next-now():25)));
  }
  state.active++;state.next=now()+limit.spacing;if(transaction)state.transactionNext=now()+limit.transactionSpacing;
  const revision=state.revision;
  function cooldown(reason,duration){state.failures++;state.revision++;state.reason=reason;state.until=Math.max(state.until,now()+duration);}
  try{
   const response=await fetcher(url,{...options,signal});
   if(!response.ok){
    if(response.status===429||response.status===503){cooldown('HTTP_'+response.status,Math.max(retryAfterMs(response.headers.get('retry-after'),now()),Math.min(120000,15000*2**Math.min(state.failures,3))));}
    const error=Error(`PROVIDER_HTTP_${response.status} ${host}`);error.provider=host;if(state.until>now())error.retryAt=state.until;throw error;
   }
   const value=await response.json();
   // A successful concurrent request cannot clear a newer 429/cooldown.
   if(revision===state.revision){state.failures=0;state.until=0;state.reason=null;}
   return value;
  }catch(error){
   if(!String(error.message).startsWith('PROVIDER_HTTP_')&&!options.signal?.aborted){
    const timeout=signal.aborted||/timeout|timed out/i.test(error.message)||error.name==='TimeoutError';
    cooldown(timeout?'TIMEOUT':'NETWORK_ERROR',Math.min(30000,1000*2**Math.min(state.failures,5)));
    const wrapped=Error(`${timeout?'PROVIDER_TIMEOUT':'PROVIDER_NETWORK_ERROR'} ${host}`);wrapped.provider=host;wrapped.retryAt=state.until;throw wrapped;
   }
   throw error;
  }finally{state.active--;}
 };
 providerHttp.cooldown=url=>{const host=new URL(url).hostname,state=states.get(host);return state?.until>now()?{until:state.until,reason:state.reason,provider:host}:null;};
 return providerHttp;
}
export const http=createProviderHttp();
