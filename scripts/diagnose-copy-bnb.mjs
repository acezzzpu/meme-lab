// Bounded, read-only probe of the exact unverified route in the supplied export.
// No .env, database, admin token, signer or execution wallet is opened.
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {keccak256} from 'ethers';
import {BSC,PAIR,FACTORY,addr,cleanError,hex} from '../core/copy/common.mjs';

export const CASE={
 endpoint:'https://bsc-dataseed.bnbchain.org',
 target:'0x80a65fcaeabbb0aa4c9a85087f9e0f7ba26f293f',
 token:'0xc3b13efa308fcfe8daea6cc12608d64b59ea7777',
 pool:'0x4907da26505772fcaad73ce1a97a2654f5c31ab4',
 block:121024377,
 transaction:'0xf1cdc757556168f751e817f24388dc90d3cbbcd58361f9e06b0e7697e6f73bd5',
 traceTransaction:'0xe1cf78d9d1e18c64883206a95b1ebf240963712d3f01544efc3e86b9b0d49f65'
};

export async function diagnose({fetcher=fetch,timeout=8000,onProgress=()=>{}}={}){
 const report={format_version:1,purpose:'READ_ONLY_BNB_ROUTE_DIAGNOSTIC',started_at:Date.now(),case:CASE,queries:[],pools:[],trace:null,read_only:true,transactions_sent:0,limitations:['This probes the public RPC from the machine running this file.','These are historical transaction probes, not an execution or live latency test.','A successful probe never enables a factory, route or LIVE mode.']};
 let sequence=0;
 const rpc=async(method,params=[])=>{
  if(!['eth_chainId','eth_blockNumber','eth_getCode','eth_call','debug_traceTransaction'].includes(method))throw Error('READ_ONLY_METHOD_REQUIRED');
  const id=++sequence,start=performance.now();
  try{
   const response=await fetcher(CASE.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(timeout)});
   if(!response.ok)throw Error('RPC_HTTP_'+response.status);
   const body=await response.json();if(body.id!==id||body.jsonrpc!=='2.0')throw Error('RPC_RESPONSE_MISMATCH');
   if(body.error)throw Error('RPC_'+body.error.code+': '+String(body.error.message).slice(0,160));
   if(!Object.hasOwn(body,'result'))throw Error('RPC_MALFORMED');
   report.queries.push({method,at:Date.now(),duration_ms:Math.round(performance.now()-start),ok:true});return {ok:true,result:body.result};
  }catch(error){const row={method,at:Date.now(),duration_ms:Math.round(performance.now()-start),ok:false,error:cleanError(error)};report.queries.push(row);return row;}
 };
 const view=async(to,abi,method,args,block)=>{
  const response=await rpc('eth_call',[{to,data:abi.encodeFunctionData(method,args)},block]);
  if(!response.ok)return response;
  try{return {ok:true,value:addr(abi.decodeFunctionResult(method,response.result)[0])};}
  catch(error){return {ok:false,error:'CONTRACT_RESPONSE: '+cleanError(error),response:response.result};}
 };
 onProgress('Verificando que el RPC sea BNB Smart Chain...');
 const chain=await rpc('eth_chainId');report.chain=chain;
 if(!chain.ok||chain.result!=='0x38'){report.status=chain.ok?'WRONG_CHAIN':'RPC_UNAVAILABLE';report.completed_at=Date.now();return report;}
 report.head=await rpc('eth_blockNumber');
 for(const block of ['latest',hex(CASE.block)]){
  onProgress('Leyendo contrato y factory de la pool: '+block);
  const [code,token0,token1,factory]=await Promise.all([
   rpc('eth_getCode',[CASE.pool,block]),view(CASE.pool,PAIR,'token0',[],block),view(CASE.pool,PAIR,'token1',[],block),view(CASE.pool,PAIR,'factory',[],block)
  ]);
  const validCode=code.ok&&typeof code.result==='string'&&/^0x([0-9a-fA-F]{2})*$/.test(code.result);
  const pool={address:CASE.pool,block,code:validCode?{ok:true,bytes:(code.result.length-2)/2,hash:keccak256(code.result)}:code.ok?{ok:false,error:'MALFORMED_CONTRACT_CODE'}:code,token0,token1,factory,registered:null,classification:'STATE_OR_CONTRACT_METHOD_UNAVAILABLE'};
  if(code.ok&&code.result==='0x')pool.classification='NO_CONTRACT_AT_THIS_BLOCK';
  else if(validCode&&token0.ok&&token1.ok&&factory.ok){
   pool.registered=await view(factory.value,FACTORY,'getPair',[token0.value,token1.value],block);
   pool.target_in_pair=[token0.value,token1.value].includes(CASE.token);
   pool.classification=!pool.registered.ok?'FACTORY_LOOKUP_UNAVAILABLE':pool.registered.value!==CASE.pool?'FACTORY_REGISTRY_MISMATCH':!pool.target_in_pair?'TARGET_NOT_IN_PAIR':factory.value!==BSC.factory?'FACTORY_NOT_SUPPORTED_BY_CURRENT_ENGINE':'PANCAKE_V2_FACTORY_VERIFIED';
  }
  report.pools.push(pool);
 }
 onProgress('Comprobando la consulta historica de BNB nativo...');
 const trace=await rpc('debug_traceTransaction',[CASE.traceTransaction,{tracer:'callTracer',tracerConfig:{onlyTopCall:false},timeout:'5s'}]);
 if(!trace.ok)report.trace=trace;
 else if(!trace.result||trace.result.error||typeof trace.result.type!=='string')report.trace={ok:false,error:trace.result?.error??'CALL_TRACER_RESPONSE_UNAVAILABLE'};
 else{
  const stack=[trace.result];let count=0,net=0n;try{
  while(stack.length&&count<50000){const call=stack.pop();count++;if(call.error)continue;
   const value=BigInt(call.value??0);if(['CALL','CREATE','CREATE2','SELFDESTRUCT'].includes(call.type)&&value){if(call.from?.toLowerCase()===CASE.target)net-=value;if(call.to?.toLowerCase()===CASE.target)net+=value;}stack.push(...call.calls??[]);
  }
  report.trace=stack.length?{ok:false,error:'TRACE_TOO_LARGE'}:{ok:true,method:'debug_traceTransaction/callTracer',calls:count,target_native_net_raw:net.toString(),note:'Public target native movement; not a copy execution or profitability calculation.'};
  }catch(error){report.trace={ok:false,error:'MALFORMED_TRACE: '+cleanError(error)};}
 }
 report.status='DIAGNOSTIC_COMPLETED';report.completed_at=Date.now();return report;
}

export async function saveDiagnostic({directory=process.cwd(),...options}={}){
 const report=await diagnose(options),stamp=new Date().toISOString().replace(/[:.]/g,'-');
 const path=resolve(directory,'diagnostico-bnb-'+stamp+'.json');await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});return {path,report};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const {path}=await saveDiagnostic({onProgress:console.log});console.log('\nDiagnostico guardado:\n'+path+'\nAdjunta ese JSON en el chat. El bot puede seguir abierto.');}
 catch(error){console.error('No se pudo guardar el diagnostico: '+cleanError(error));process.exitCode=1;}
}
