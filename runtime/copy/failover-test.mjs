import {BscRpc} from './rpc.mjs';
import {check,cleanError} from '../../core/copy/common.mjs';

// Isolated fault injection. The live connection is not disconnected. Only the
// fallback reads go to the real network and enter the engine's traffic counters.
export async function testRateLimitFailover(e){
 const providers=e.rpc.providers.filter(p=>!['archive','benchmark'].includes(p.role));
 if(providers.length<2)return {passed:false,reason:'SECOND_PROVIDER_REQUIRED'};
 const primary=providers[0];let injected=0,actualReads=0;
 const rpc=new BscRpc(providers,{fetcher:async(url,request)=>{
  if(url===primary.http_url){injected++;return new Response(JSON.stringify({error:{code:-32003,message:'daily request limit reached — injected test fault'}}),{status:429});}
  const p=providers.find(p=>p.http_url===url),body=JSON.parse(request.body);actualReads++;
  const work=()=>e.rpc.request(p,body.method,body.params,3000);
  const result=await e.rpc.withContext({pipeline:'SELF_TEST',priority:1},work);return new Response(JSON.stringify({result}));
 }});
 const start=performance.now();let result;
 try{const first=await rpc.call('eth_blockNumber'),second=await rpc.call('eth_blockNumber');check(injected===1&&BigInt(first)>0n&&BigInt(second)>0n,'FAILOVER_CHECK_FAILED');result={passed:true,fault:'INJECTED_HTTP_429_DAILY_QUOTA',network:'REAL_BSC_FALLBACK_READS',injected_calls:injected,actual_reads:actualReads,first_block:Number(BigInt(first)),second_block:Number(BigInt(second)),fallback:rpc.failover.last?.provider,duration_ms:performance.now()-start};}
 catch(error){result={passed:false,fault:'INJECTED_HTTP_429_DAILY_QUOTA',injected_calls:injected,actual_reads:actualReads,error:cleanError(error)};}
 await e.store.set('copy_rate_limit_failover_test',{...result,at:Date.now()});return result;
}
