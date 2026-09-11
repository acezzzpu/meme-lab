import {BSC} from '../../core/copy/common.mjs';
const factories=new Set([BSC.factory,BSC.v3factory,'0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7']);
export function poolLookupTtl(to,value){return factories.has(to.toLowerCase())&&/^0x[0-9a-f]{64}$/i.test(value)&&BigInt(value)>0n?86400000:10000;}
export async function restoreRouteMetadata(rpc,store){
 rpc.authenticatedPoolCache??=new Map();rpc.poolFlights??=new Map();
 try{const saved=await store.setting('copy_authenticated_route_metadata');if(saved?.version===1&&saved.chain_id===56){for(const [key,p] of saved.pools??[])if(factories.has(p.factory)&&p.address&&p.token0&&p.token1)rpc.authenticatedPoolCache.set(key,p);for(const [key,v] of saved.lookups??[])if(v.until>Date.now()&&poolLookupTtl(key.split(':')[0],v.value)===86400000)rpc.cache.set(key,v);}}catch{/* Diagnostic cache loss must not stop capture. */}
 let timer=null;
 const flush=async()=>{timer=null;const lookups=[...rpc.cache].filter(([k,v])=>poolLookupTtl(k.split(':')[0],v.value)===86400000&&v.until>Date.now()).slice(-1000);await store.set('copy_authenticated_route_metadata',{version:1,chain_id:56,at:Date.now(),pools:[...rpc.authenticatedPoolCache].slice(-1000),lookups});};
 rpc.routeMetadataChanged=()=>{if(!timer){timer=setTimeout(()=>flush().catch(()=>{}),250);timer.unref?.();}};
 rpc.flushRouteMetadata=async()=>{if(timer){clearTimeout(timer);timer=null;await flush();}};
}
// Identical integer formula to the canonical Pancake V2 library. Research helper
// only until same-block equality is checked against the deployed router.
export function localV2AmountOut(amount,reserveIn,reserveOut){amount=BigInt(amount);reserveIn=BigInt(reserveIn);reserveOut=BigInt(reserveOut);if(amount<=0n||reserveIn<=0n||reserveOut<=0n)throw Error('V2_INVALID_RESERVES_OR_AMOUNT');const feeAmount=amount*9975n;return feeAmount*reserveOut/(reserveIn*10000n+feeAmount);}
