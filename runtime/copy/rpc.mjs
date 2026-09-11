import {AsyncLocalStorage} from 'node:async_hooks';
import {RpcTelemetry} from './rpc-telemetry.mjs';
import {BSC,check,encode,cleanError,hex} from '../../core/copy/common.mjs';
function abortable(task,signal){
 if(signal.aborted)return Promise.reject(signal.reason);
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});Promise.resolve(task).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
export class BscRpc {
 constructor(providers,{timeout=4000,fetcher=fetch,maxConcurrent=4,hedgeMs=350,telemetry=new RpcTelemetry(),pipeline='LIVE_TARGET_PIPELINE'}={}){this.providers=providers.filter(p=>p.enabled);this.timeout=timeout;this.fetcher=fetcher;this.hedgeMs=hedgeMs;this.telemetry=telemetry;this.pipeline=pipeline;this.cache=new Map();this.cacheFlights=new Map();this.maxConcurrent=Math.max(2,maxConcurrent);this.sequence=0;this.verified=new Set();this.verifying=new Map();this.cooldown=new Map();this.failures=new Map();this.unsupported=new Map();this.slots=new Map();this.context=new AsyncLocalStorage();this.metrics=[];this.failover={attempts:0,successes:0,last:null};this.telemetry.failover=this.failover;}
 withContext(options,work){return this.context.run({...this.context.getStore(),...options},work);}
 acquire(id,priority,signal){
  let state=this.slots.get(id);if(!state){const rps=this.providers.find(p=>p.id===id)?.requests_per_second;state={active:0,background:0,queue:[],interval:Number.isFinite(rps)&&rps>0?1000/rps:0,nextStart:0,timer:null};this.slots.set(id,state);}
  return new Promise((resolve,reject)=>{
   const item={priority,resolve,reject,signal,abort:null};item.abort=()=>{state.queue=state.queue.filter(x=>x!==item);reject(signal.reason);if(!state.queue.length&&state.timer){clearTimeout(state.timer);state.timer=null;}};
   if(signal.aborted)return reject(signal.reason);if(state.queue.length>=64)return reject(Error('RPC_QUEUE_FULL'));
   signal.addEventListener('abort',item.abort,{once:true});state.queue.push(item);this.drain(state);
  });
 }
 drain(state){
  state.queue.sort((a,b)=>b.priority-a.priority);
  while(state.active<this.maxConcurrent){const i=state.queue.findIndex(x=>x.priority>=0||state.background<1&&state.active<this.maxConcurrent-1);if(i<0)break;
   const wait=state.nextStart-performance.now();if(wait>0){if(!state.timer)state.timer=setTimeout(()=>{state.timer=null;this.drain(state);},Math.ceil(wait));return;}
   const x=state.queue.splice(i,1)[0];x.signal.removeEventListener('abort',x.abort);if(x.signal.aborted){x.reject(x.signal.reason);continue;}
   state.nextStart=performance.now()+state.interval;
   state.active++;if(x.priority<0)state.background++;let done=false;
   x.resolve(()=>{if(done)return;done=true;state.active--;if(x.priority<0)state.background--;this.drain(state);});
  }
 }
 status(){return this.providers.map(p=>({provider:p.id,backoff_until:this.cooldown.get(p.id)??null,active:this.slots.get(p.id)?.active??0,queued:this.slots.get(p.id)?.queue.length??0,trace_unavailable_until:this.unsupported.get(p.id+':debug_traceTransaction')??null}));}
 degrade(provider,error,retryAfter=0){
  if(!/timeout|timed out|abort|fetch failed|network|connection|RPC_HTTP_(429|5\d\d)|quota|daily.*limit|rate.?limit|request limit|maximum API usage|ran out of cu|WS_CONNECTION/i.test(error))return;
  const count=(this.failures.get(provider.id)??0)+1;this.failures.set(provider.id,count);
  const daily=/daily.*limit|quota.*exceed|credits.*exhaust|ran out of cu/i.test(error),base=daily?3600000:count>=8?300000:Math.min(60000,1000*2**Math.min(count,6));
  this.cooldown.set(provider.id,Date.now()+Math.max(retryAfter,Math.ceil(base*(1+Math.random()*.2))));
 }
 async cached(key,ttl,work){
  const cached=this.cache.get(key);if(cached&&cached.until>Date.now()){if(this.context.getStore()?.quoteTrace)this.context.getStore().quoteTrace.cache.hits++;this.telemetry.cache(true);return cached.value;}
  if(this.cacheFlights.has(key)){this.telemetry.cache(true);const signal=this.context.getStore()?.signal;return signal?abortable(this.cacheFlights.get(key),signal):this.cacheFlights.get(key);}
  if(this.context.getStore()?.quoteTrace)this.context.getStore().quoteTrace.cache.misses++;this.telemetry.cache(false);const signal=this.context.getStore()?.signal;
  // Immutable/short-lived reads are shared. One quote losing its race must not
  // cancel the metadata read needed by the winning quote. The RPC still times out.
  const task=this.withContext({signal:undefined},work).then(value=>{if(value!==null)this.cache.set(key,{value,until:Date.now()+ttl});if(this.cache.size>2000)this.cache.delete(this.cache.keys().next().value);return value;}).finally(()=>this.cacheFlights.delete(key));
  this.cacheFlights.set(key,task);return signal?abortable(task,signal):task;
 }
 async request(provider,method,params=[],timeout=this.timeout){
  const context=this.context.getStore()??{},pipeline=context.pipeline??this.pipeline,budget=AbortSignal.timeout(Math.max(1,timeout)),signal=context.signal?AbortSignal.any([budget,context.signal]):budget;
  if(Date.now()<(this.cooldown.get(provider.id)??0)){this.telemetry.suppress('PROVIDER_DEGRADED');throw Error('RPC_BACKOFF');}
  if(pipeline==='HISTORICAL_BACKFILL_PIPELINE'){
   check(provider.history_dedicated===true,'BACKFILL_REQUIRES_SEPARATE_QUOTA');
   const usage=this.telemetry.snapshot([provider]).providers[0];check(!usage.backfill_paused,'BACKFILL_PAUSED_AT_80_PERCENT');
  }
  if(method!=='eth_chainId'&&!this.verified.has(provider.id)){
   if(!this.verifying.has(provider.id)){const task=this.context.run(context.beforeRequest?{beforeRequest:context.beforeRequest,pipeline:context.pipeline,priority:context.priority}:{},()=>this.request(provider,'eth_chainId',[],this.timeout));this.verifying.set(provider.id,task);task.finally(()=>this.verifying.delete(provider.id)).catch(()=>{});}
   await abortable(this.verifying.get(provider.id),signal);
  }
  signal.throwIfAborted();check(Date.now()>=(this.cooldown.get(provider.id)??0),'RPC_BACKOFF');
  check(Date.now()>=(this.unsupported.get(provider.id+':'+method)??0),'RPC_METHOD_UNAVAILABLE_CACHED: '+method);
  const started=performance.now(),priority=context.priority??(method==='debug_traceTransaction'?-1:0);const release=await this.acquire(provider.id,priority,signal);
  const wireStarted=performance.now();let retryAfter=0,httpStatus=0,sent=false,outcomeStatus="OK",outcomeError=null;
  try{
   signal.throwIfAborted();check(Date.now()>=(this.cooldown.get(provider.id)??0),'RPC_BACKOFF');check(Date.now()>=(this.unsupported.get(provider.id+':'+method)??0),'RPC_METHOD_UNAVAILABLE_CACHED: '+method);
   context.beforeRequest?.();sent=true;this.telemetry.add(provider.id,method,{pipeline,units:method.startsWith('debug_')?(provider.credit_unit??0)*2:provider.credit_unit??0});
   const r=await abortable(this.fetcher(provider.http_url,{method:'POST',headers:{'Content-Type':'application/json'},body:encode({jsonrpc:'2.0',id:++this.sequence,method,params}),signal}),signal);httpStatus=r.status;
   if(r.status===429||r.status===503){const value=r.headers.get('retry-after');retryAfter=Math.min(60000,Math.max(3000,Number.isFinite(Number(value))?Number(value)*1000:Date.parse(value)-Date.now()||3000));}
   const data=await abortable(r.json().catch(()=>({})),signal);
   // Render measured repeated 403 receipt denials on PublicNode. Suppress only
   // this explicitly denied method briefly; retain its working head/block reads.
   if(method==='eth_getTransactionReceipt'&&r.status===403&&/archive requests require a personal token/i.test(data.error?.message??''))this.unsupported.set(provider.id+':'+method,Date.now()+60000);
   check(r.ok,'RPC_HTTP_'+r.status+': '+String(data.error?.message??'').slice(0,160));
   if(data.error&&(data.error.code===-32601||/not (available|supported)|method not found|method.*disabled/i.test(data.error.message??'')))this.unsupported.set(provider.id+':'+method,Date.now()+600000);
   if(data.error&&method==='debug_traceTransaction'&&(data.error.code===-32601||/not (available|supported)|method not found/i.test(data.error.message??'')))this.unsupported.set(provider.id+':'+method,Date.now()+600000);
   if(data.error){const error=Error('RPC_'+data.error.code+': '+String(data.error.message??'').slice(0,140));error.rpc_error={code:data.error.code,message:data.error.message,data:data.error.data};error.data=data.error.data;error.provider=provider.id;error.method=method;throw error;}check(Object.hasOwn(data,'result'),'RPC_MALFORMED');
   if(method==='eth_chainId'){check(Number(BigInt(data.result))===56,'WRONG_CHAIN_ID');this.verified.add(provider.id);}
   this.failures.set(provider.id,0);this.metrics.push({provider:provider.id,method,at:Date.now(),duration_ms:performance.now()-started,status:'OK'});return data.result;
  }catch(e){
   const cancelled=!!context.signal?.aborted,error=cleanError(e);outcomeStatus=cancelled?"CANCELLED":"ERROR";outcomeError=error;
   if(!cancelled)this.degrade(provider,error,retryAfter);
   if(sent)this.telemetry.outcome(provider.id,method,{pipeline,error,cancelled,status:httpStatus});
   this.metrics.push({provider:provider.id,method,at:Date.now(),duration_ms:performance.now()-started,status:cancelled?'CANCELLED':'ERROR',error});throw e;
  }finally{if(sent&&context.quoteTrace)context.quoteTrace.rpc({provider:provider.id,method,contract_method:context.contractMethod??null,to:context.contractAddress??null,start_ms:started-context.quoteTrace.started,wire_ms:performance.now()-wireStarted,queue_ms:wireStarted-started,status:outcomeStatus,error:outcomeError});if(sent)this.telemetry.timing(provider.id,method,{pipeline,duration_ms:performance.now()-wireStarted,queue_ms:wireStarted-started,status:outcomeStatus,error:outcomeError});release();if(this.metrics.length>300)this.metrics.splice(0,this.metrics.length-300);}
 }
 async call(method,params=[],{timeout,provider}={}){
  if(provider)return this.request(provider,method,params,timeout);
  const active=this.providers.filter(p=>!['archive','benchmark'].includes(p.role));
  if(method==='eth_getTransactionReceipt')active.sort((a,b)=>Number(!!b.receipt_primary)-Number(!!a.receipt_primary));
  check(active.length,'BSC_PROVIDER_NOT_CONFIGURED');
  // No eager duplicate reads. A fallback starts only after a failure or a slow
  // primary. Each endpoint is attempted at most once per logical request.
  if(method==='eth_sendRawTransaction')return this.request(active[0],method,params,timeout);
  const eligible=active.filter(p=>Date.now()>=(this.cooldown.get(p.id)??0)&&Date.now()>=(this.unsupported.get(p.id+':'+method)??0));
  check(eligible.length,active.every(p=>Date.now()<(this.unsupported.get(p.id+':'+method)??0))?'RPC_METHOD_UNAVAILABLE_CACHED: '+method:'RPC_BACKOFF: ALL_BSC_PROVIDERS_DEGRADED');
  const parent=this.context.getStore(),controllers=[],timers=new Set(),errors=[];let cursor=0,running=0,finished=false;
  return new Promise((resolve,reject)=>{
   const finish=(error,result)=>{if(finished)return;finished=true;for(const timer of timers)clearTimeout(timer);controllers.forEach(c=>c.abort(Error('REDUNDANT_READ_COMPLETED')));error?reject(error):resolve(result);};
   const launch=()=>{if(finished||cursor>=eligible.length)return;const index=cursor++,p=eligible[index],controller=new AbortController();controllers.push(controller);running++;if(index)this.failover.attempts++;
    const timer=setTimeout(()=>{timers.delete(timer);launch();},method==='eth_getBlockByNumber'?Math.max(1000,this.hedgeMs):this.hedgeMs);timers.add(timer);
    this.withContext({signal:parent?.signal?AbortSignal.any([parent.signal,controller.signal]):controller.signal},()=>this.request(p,method,params,timeout)).then(result=>{
     if(result===null&&['eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber'].includes(method))throw Error('RPC_RESULT_PENDING');
     if(index||p.id!==active[0].id){this.failover.successes++;this.failover.last={at:Date.now(),method,provider:p.id,previous_provider:active[0].id};}finish(null,result);
    }).catch(error=>{errors.push(error);launch();}).finally(()=>{running--;clearTimeout(timer);timers.delete(timer);if(!finished&&!running&&cursor===eligible.length)finish(errors.every(e=>e.message==='RPC_RESULT_PENDING')?null:errors.find(e=>e.message!=='RPC_RESULT_PENDING'),null);});
   };launch();
  });
 }
 async verify(){const chain=await this.call('eth_chainId');check(Number(BigInt(chain))===BSC.chainId,'WRONG_CHAIN_ID');return Number(BigInt(await this.call('eth_blockNumber')));}
 async contract(to,abi,method,args=[],block='latest'){const trace=this.context.getStore()?.quoteTrace,started=performance.now();try{const data=abi.encodeFunctionData(method,args),read=()=>this.withContext({contractMethod:method,contractAddress:to},()=>this.call('eth_call',[{to,data},block]));const immutable=['decimals','symbol','token0','token1','factory','fee','WETH'].includes(method),pool=['getPair','getPool'].includes(method);const out=immutable||pool?await this.cached(to.toLowerCase()+':'+data,immutable?3600000:60000,read):await read();return abi.decodeFunctionResult(method,out);}finally{trace?.contract(method,started,performance.now());}}
 async benchmark(){const results=await Promise.allSettled(this.providers.map(async p=>{const start=performance.now();const chain=await this.request(p,'eth_chainId');check(Number(BigInt(chain))===56,'WRONG_CHAIN_ID');const block=await this.request(p,'eth_getBlockByNumber',['latest',false]);return {provider:p.id,chain_id:56,block:Number(BigInt(block.number)),block_at:Number(BigInt(block.timestamp))*1000,received_at:Date.now(),duration_ms:performance.now()-start,method:'HTTP chainId + latest block'};}));return results.map((r,i)=>r.status==='fulfilled'?r.value:{provider:this.providers[i].id,error:cleanError(r.reason)});}
}
export async function tokenMetadata(rpc,token){const {ERC20}=await import('../../core/copy/common.mjs');const [[d],s]=await Promise.all([rpc.contract(token,ERC20,'decimals'),rpc.contract(token,ERC20,'symbol').catch(()=>[null])]);check(Number(d)<=36,'UNSUPPORTED_DECIMALS');return {decimals:Number(d),symbol:s[0]??token.slice(0,8)};}
export const blockTag=n=>hex(n);
