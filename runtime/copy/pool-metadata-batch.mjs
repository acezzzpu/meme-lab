import {Interface,keccak256} from 'ethers';
import {PAIR,check} from '../../core/copy/common.mjs';
export const MULTICALL3='0xca11bde05977b3631167028862be2a173976ca11';
// Runtime hash derived from the official deployment initcode: return 0x0ee0
// bytes starting at offset 0x20. https://github.com/mds1/multicall#new-deployments
export const MULTICALL3_CODE_HASH='0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';
export const MULTICALL_ABI=new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const methods=['token0','token1','factory','fee'];
export async function readPoolMetadata(rpc,address){
 const legacy=async()=>({base:await Promise.all(methods.slice(0,3).map(m=>rpc.contract(address,PAIR,m))),fee:null});
 if(!rpc.call||!rpc.context||rpc.poolMetadataBatch===false)return legacy();
 if(methods.slice(0,3).every(m=>(rpc.cache.get(address+':'+PAIR.encodeFunctionData(m))?.until??0)>Date.now()))return legacy();
 // One verification per RPC instance. Failure preserves the original reader.
 rpc.multicallCodeVerified??=rpc.withContext({signal:undefined},()=>rpc.call('eth_getCode',[MULTICALL3,'latest'])).then(code=>keccak256(code)===MULTICALL3_CODE_HASH).catch(()=>false);
 if(!await rpc.multicallCodeVerified)return legacy();
 const trace=rpc.context.getStore()?.quoteTrace,start=performance.now();
 try{
  const data=MULTICALL_ABI.encodeFunctionData('aggregate3',[methods.map(m=>[address,true,PAIR.encodeFunctionData(m)])]);
  const raw=await rpc.withContext({contractMethod:'POOL_METADATA_BATCH',contractAddress:address},()=>rpc.call('eth_call',[{to:MULTICALL3,data},'latest']));
  const [rows]=MULTICALL_ABI.decodeFunctionResult('aggregate3',raw);check(rows.length===4,'POOL_METADATA_BATCH_INCOMPLETE');
  check(rows.slice(0,3).every(x=>x.success),'POOL_METADATA_INTERFACE_UNSUPPORTED');
  return {base:rows.slice(0,3).map((r,i)=>PAIR.decodeFunctionResult(methods[i],r.returnData)),fee:rows[3].success?PAIR.decodeFunctionResult('fee',rows[3].returnData):null};
 }catch(error){
  if(rpc.context.getStore()?.signal?.aborted)throw error;
  if(/POOL_METADATA_INTERFACE_UNSUPPORTED/.test(error.message))throw error;
  // An RPC/ABI failure disables this optimization for the instance and falls
  // back to the previously tested reads; factory authentication is unchanged.
  rpc.poolMetadataBatch=false;return legacy();
 }finally{trace?.contract('POOL_METADATA_BATCH',start,performance.now());}
}
