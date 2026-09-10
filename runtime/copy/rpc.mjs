import {AsyncLocalStorage} from 'node:async_hooks';
import {BSC,check,encode,cleanError,hex} from '../../core/copy/common.mjs';
function abortable(task,signal){
 if(signal.aborted)return Promise.reject(signal.reason);
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});Promise.resolve(task).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
export class BscRpc {
 constructor(providers,{timeout=4000,fetcher=fetch,maxConcurrent=4}={}){this.providers=providers.filter(p=>p.enabled);this.timeout=timeout;this.fetcher=fetcher;this.maxConcurrent=Math.max(2,maxConcurrent);this.sequence=0;this.verified=new Set();this.verifying=new Map();this.cooldown=new Map();this.failures=new Map();this.unsupported=new Map();this.slots=new Map();this.context=new AsyncLocalStorage();this.metrics=[];}
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
 async request(provider,method,params=[],timeout=this.timeout){
  const context=this.context.getStore()??{},budget=AbortSignal.timeout(Math.max(1,timeout)),signal=context.signal?AbortSignal.any([budget,context.signal]):budget;
  if(method!=='eth_chainId'&&!this.verified.has(provider.id)){
   if(!this.verifying.has(provider.id)){const task=this.context.run({},()=>this.request(provider,'eth_chainId',[],this.timeout));this.verifying.set(provider.id,task);task.finally(()=>this.verifying.delete(provider.id)).catch(()=>{});}
   await abortable(this.verifying.get(provider.id),signal);
  }
  signal.throwIfAborted();check(Date.now()>=(this.cooldown.get(provider.id)??0),'RPC_BACKOFF');
  check(Date.now()>=(this.unsupported.get(provider.id+':'+method)??0),'RPC_METHOD_UNAVAILABLE_CACHED: '+method);
  const started=performance.now(),priority=context.priority??(method==='debug_traceTransaction'?-1:0);const release=await this.acquire(provider.id,priority,signal);
  let retryAfter=0;
  try{
   signal.throwIfAborted();check(Date.now()>=(this.cooldown.get(provider.id)??0),'RPC_BACKOFF');check(Date.now()>=(this.unsupported.get(provider.id+':'+method)??0),'RPC_METHOD_UNAVAILABLE_CACHED: '+method);
   const r=await abortable(this.fetcher(provider.http_url,{method:'POST',headers:{'Content-Type':'application/json'},body:encode({jsonrpc:'2.0',id:++this.sequence,method,params}),signal}),signal);
   if(r.status===429||r.status===503){const value=r.headers.get('retry-after');retryAfter=Math.min(60000,Math.max(3000,Number.isFinite(Number(value))?Number(value)*1000:Date.parse(value)-Date.now()||3000));}
   check(r.ok,'RPC_HTTP_'+r.status);const data=await abortable(r.json(),signal);
   if(data.error&&method==='debug_traceTransaction'&&(data.error.code===-32601||/not (available|supported)|method not found/i.test(data.error.message??'')))this.unsupported.set(provider.id+':'+method,Date.now()+600000);
   check(!data.error,'RPC_'+data.error?.code+': '+String(data.error?.message??'').slice(0,140));check(Object.hasOwn(data,'result'),'RPC_MALFORMED');
   if(method==='eth_chainId'){check(Number(BigInt(data.result))===56,'WRONG_CHAIN_ID');this.verified.add(provider.id);}
   this.failures.set(provider.id,0);this.metrics.push({provider:provider.id,method,at:Date.now(),duration_ms:performance.now()-started,status:'OK'});return data.result;
  }catch(e){
   const cancelled=!!context.signal?.aborted,error=cleanError(e);
   if(!cancelled&&(/timeout|timed out|abort|fetch failed|network|RPC_HTTP_(429|5\d\d)/i.test(error))){const count=(this.failures.get(provider.id)??0)+1;this.failures.set(provider.id,count);this.cooldown.set(provider.id,Date.now()+Math.max(retryAfter,Math.min(30000,1000*2**Math.min(count,5))));}
   this.metrics.push({provider:provider.id,method,at:Date.now(),duration_ms:performance.now()-started,status:cancelled?'CANCELLED':'ERROR',error});throw e;
  }finally{release();if(this.metrics.length>300)this.metrics.splice(0,this.metrics.length-300);}
 }
 async call(method,params=[],{timeout,provider}={}){
  if(provider)return this.request(provider,method,params,timeout);
  const active=this.providers.filter(p=>!['archive','benchmark'].includes(p.role));
  check(active.length,'BSC_PROVIDER_NOT_CONFIGURED');
  // Never race broadcasts. Redundant read-only requests use independent budgets;
  // a slow primary cannot hold the secondary behind its timeout/backoff.
  if(method==='eth_sendRawTransaction'||active.length===1)return this.request(active[0],method,params,timeout);
  const parent=this.context.getStore(),controllers=active.slice(0,2).map(()=>new AbortController());
  try{return await Promise.any(active.slice(0,2).map((p,i)=>this.withContext({signal:parent?.signal?AbortSignal.any([parent.signal,controllers[i].signal]):controllers[i].signal},async()=>{
   const result=await this.request(p,method,params,timeout);
   if(result===null&&['eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber'].includes(method))throw Error('RPC_RESULT_PENDING');
   return result;
  })));}catch(e){if(e.errors?.every(x=>x.message==='RPC_RESULT_PENDING'))return null;throw e.errors?.find(x=>x.message!=='RPC_RESULT_PENDING')??e;}
  finally{controllers.forEach(c=>c.abort(Error('REDUNDANT_READ_COMPLETED')));}
 }
 async verify(){const chain=await this.call('eth_chainId');check(Number(BigInt(chain))===BSC.chainId,'WRONG_CHAIN_ID');return Number(BigInt(await this.call('eth_blockNumber')));}
 async contract(to,abi,method,args=[],block='latest'){const out=await this.call('eth_call',[{to,data:abi.encodeFunctionData(method,args)},block]);return abi.decodeFunctionResult(method,out);}
 async benchmark(){const results=await Promise.allSettled(this.providers.map(async p=>{const start=performance.now();const chain=await this.request(p,'eth_chainId');check(Number(BigInt(chain))===56,'WRONG_CHAIN_ID');const block=await this.request(p,'eth_getBlockByNumber',['latest',false]);return {provider:p.id,chain_id:56,block:Number(BigInt(block.number)),block_at:Number(BigInt(block.timestamp))*1000,received_at:Date.now(),duration_ms:performance.now()-start,method:'HTTP chainId + latest block'};}));return results.map((r,i)=>r.status==='fulfilled'?r.value:{provider:this.providers[i].id,error:cleanError(r.reason)});}
}
export async function tokenMetadata(rpc,token){const {ERC20}=await import('../../core/copy/common.mjs');const [[d],s]=await Promise.all([rpc.contract(token,ERC20,'decimals'),rpc.contract(token,ERC20,'symbol').catch(()=>[null])]);check(Number(d)<=36,'UNSUPPORTED_DECIMALS');return {decimals:Number(d),symbol:s[0]??token.slice(0,8)};}
export const blockTag=n=>hex(n);
