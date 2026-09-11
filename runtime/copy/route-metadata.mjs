import {BSC,PAIR,FACTORY,V3FACTORY,V2_SWAP,V3_SWAP,PANCAKE_V3_SWAP} from '../../core/copy/common.mjs';
const factories=new Set([BSC.factory,BSC.v3factory,'0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7']);
const factoryFor={PANCAKE_V2:BSC.factory,PANCAKE_V3:BSC.v3factory,UNISWAP_V3:'0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7'},topicFor={PANCAKE_V2:V2_SWAP,PANCAKE_V3:PANCAKE_V3_SWAP,UNISWAP_V3:V3_SWAP};
export function restoreAuthenticatedPool(rpc,p){
 if(!p||factoryFor[p.adapter]!==p.factory||![p.address,p.token0,p.token1].every(x=>/^0x[0-9a-f]{40}$/.test(x??''))||p.token0===p.token1||p.adapter!=='PANCAKE_V2'&&(!Number.isInteger(p.fee)||p.fee<=0||p.fee>=1000000))return false;
 const pool={address:p.address,token0:p.token0,token1:p.token1,factory:p.factory,fee:p.adapter==='PANCAKE_V2'?null:p.fee,adapter:p.adapter};
 for(const topic of ['undefined',topicFor[p.adapter]])rpc.authenticatedPoolCache.set(p.address+':'+topic,pool);
 const cache=(to,abi,method,args,value)=>rpc.cache.set(to+':'+abi.encodeFunctionData(method,args),{value:abi.encodeFunctionResult(method,[value]),until:Date.now()+86400000});
 for(const method of ['token0','token1','factory'])cache(p.address,PAIR,method,[],p[method]);if(p.adapter!=='PANCAKE_V2')cache(p.address,PAIR,'fee',[],p.fee);
 for(const tokens of [[p.token0,p.token1],[p.token1,p.token0]]){if(p.adapter==='PANCAKE_V2')cache(p.factory,FACTORY,'getPair',tokens,p.address);else cache(p.factory,V3FACTORY,'getPool',[...tokens,p.fee],p.address);}
 return true;
}
export function poolLookupTtl(to,value){return factories.has(to.toLowerCase())&&/^0x[0-9a-f]{64}$/i.test(value)&&BigInt(value)>0n?86400000:10000;}
export async function restoreRouteMetadata(rpc,store){
 rpc.authenticatedPoolCache??=new Map();rpc.poolFlights??=new Map();
 try{const saved=await store.setting('copy_authenticated_route_metadata');if(saved?.version===1&&saved.chain_id===56){for(const [,p] of saved.pools??[])restoreAuthenticatedPool(rpc,p);for(const [key,v] of saved.lookups??[])if(v.until>Date.now()&&poolLookupTtl(key.split(':')[0],v.value)===86400000)rpc.cache.set(key,v);}
  // Earlier successful PAPER_DEX_PATH quotes already authenticated these exact
  // immutable tuples against the canonical factory. Reuse that persisted proof;
  // event hints, token labels, reserves and prices are never accepted as proof.
  const rows=await store.all?.("SELECT json_extract(data,'$.quote.hops') hops FROM copy_actions WHERE state='FILLED' AND json_extract(data,'$.quote.provider')='PAPER_DEX_PATH' ORDER BY created_at DESC LIMIT 100")??[];
  for(const row of rows)for(const p of JSON.parse(row.hops??'[]'))restoreAuthenticatedPool(rpc,p);
 }catch{/* Cache loss must not stop capture. */}
 let timer=null;
 const flush=async()=>{timer=null;const lookups=[...rpc.cache].filter(([k,v])=>poolLookupTtl(k.split(':')[0],v.value)===86400000&&v.until>Date.now()).slice(-1000);await store.set('copy_authenticated_route_metadata',{version:1,chain_id:56,at:Date.now(),pools:[...rpc.authenticatedPoolCache].slice(-1000),lookups});};
 rpc.routeMetadataChanged=()=>{if(!timer){timer=setTimeout(()=>flush().catch(()=>{}),250);timer.unref?.();}};
 rpc.flushRouteMetadata=async()=>{if(timer){clearTimeout(timer);timer=null;await flush();}};
}
// Canonical Pancake V2 formula; three same-block Render router comparisons
// established exact integer equality before using it in direct V2 quotes.
export function localV2AmountOut(amount,reserveIn,reserveOut){amount=BigInt(amount);reserveIn=BigInt(reserveIn);reserveOut=BigInt(reserveOut);if(amount<=0n||reserveIn<=0n||reserveOut<=0n)throw Error('V2_INVALID_RESERVES_OR_AMOUNT');const feeAmount=amount*9975n;return feeAmount*reserveOut/(reserveIn*10000n+feeAmount);}
