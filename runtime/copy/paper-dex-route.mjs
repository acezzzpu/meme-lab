import {BSC,PAIR,FACTORY,V3FACTORY,QUOTER_V3,ROUTER,V2_SWAP,V3_SWAP,PANCAKE_V3_SWAP,addr,v3Path,check} from '../../core/copy/common.mjs';
const UNI_FACTORY='0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7';
const UNI_QUOTER='0x78d78e420da98ad378d7799be8f4af69033eb077';
// Official Uniswap BNB deployment: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments
// PAPER only: current quotes for independently authenticated pool paths. This
// does not claim an atomic transaction, router calldata or transfer-tax success.
export class PaperDexRoute {
 constructor(rpc){this.rpc=rpc;this.id='PAPER_DEX_PATH';this.cache=rpc.authenticatedPoolCache??=new Map();this.flights=rpc.poolFlights??=new Map();}
 async pool(hint){
  const address=addr(hint.address),key=address+':'+hint.topic,cached=this.cache.get(key);if(cached)return cached;if(this.flights.has(key))return this.flights.get(key);
  const work=this.loadPool(hint,key);this.flights.set(key,work);try{return await work;}finally{this.flights.delete(key);}
 }
 async loadPool(hint,key){const address=addr(hint.address);
  const [[a],[b],[f]]=await Promise.all(['token0','token1','factory'].map(m=>this.rpc.contract(address,PAIR,m)));
  const token0=addr(a),token1=addr(b),factory=addr(f);let fee=null,adapter,registered;
  if(factory===BSC.factory&&(!hint.topic||hint.topic===V2_SWAP)){adapter='PANCAKE_V2';[registered]=await this.rpc.contract(factory,FACTORY,'getPair',[token0,token1]);}
  else if(factory===UNI_FACTORY&&(!hint.topic||hint.topic===V3_SWAP)||factory===BSC.v3factory&&(!hint.topic||hint.topic===PANCAKE_V3_SWAP)){
   [fee]=await this.rpc.contract(address,PAIR,'fee');adapter=factory===UNI_FACTORY?'UNISWAP_V3':'PANCAKE_V3';[registered]=await this.rpc.contract(factory,V3FACTORY,'getPool',[token0,token1,fee]);
  }else throw Error('PAPER_POOL_FACTORY_UNSUPPORTED');
  check(addr(registered)===address,'PAPER_POOL_NOT_REGISTERED');const p={address,token0,token1,factory,fee:fee===null?null:Number(fee),adapter};this.cache.set(key,p);this.rpc.routeMetadataChanged?.();if(this.cache.size>1000)this.cache.delete(this.cache.keys().next().value);return p;
 }
 async quote({paper,side,token,amount,slippageBps,candidatePools=[]}){
  check(paper,'PAPER_PATH_NOT_LIVE_EXECUTABLE');check(candidatePools.length,'NO_PAPER_POOL_CANDIDATES');const start=performance.now();
  const settled=await Promise.allSettled(candidatePools.slice(0,12).map(h=>this.pool(h))),pools=settled.filter(r=>r.status==='fulfilled').map(r=>r.value);
  const input=side==='BUY'?BSC.wbnb:token,output=side==='BUY'?token:BSC.wbnb,paths=[];
  function walk(current,path,seen){if(current===output){paths.push(path);return;}if(path.length===4)return;for(const p of pools){if(![p.token0,p.token1].includes(current))continue;const next=p.token0===current?p.token1:p.token0;if(!seen.has(next))walk(next,[...path,{...p,tokenIn:current,tokenOut:next}],new Set([...seen,next]));}}
  walk(input,[],new Set([input]));check(paths.length,'NO_AUTHENTICATED_PAPER_PATH');
  const [block,gasHex]=await Promise.all([this.rpc.call('eth_blockNumber'),this.rpc.call('eth_gasPrice')]);const quoteAt=Date.now(),gasPrice=BigInt(gasHex);
  const attempts=await Promise.allSettled(paths.slice(0,4).map(async hops=>{let output=BigInt(amount),gas=100000n;
   for(const h of hops){if(h.adapter==='PANCAKE_V2'){const [values]=await this.rpc.contract(BSC.router,ROUTER,'getAmountsOut',[output,[h.tokenIn,h.tokenOut]],block);output=values.at(-1);gas+=130000n;}
    else{const [next,,,estimate]=await this.rpc.contract(h.adapter==='UNISWAP_V3'?UNI_QUOTER:BSC.quoterV3,QUOTER_V3,'quoteExactInput',[v3Path([h.tokenIn,h.tokenOut],[h.fee]),output],block);output=next;gas+=estimate*150n/100n;}
    check(output>0n,'PAPER_PATH_ZERO_OUTPUT');
   }return {hops,output,gas};}));
  const valid=attempts.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>a.output>b.output?-1:1);check(valid.length,'PAPER_PATH_QUOTE_FAILED');const best=valid[0];
  return {provider:this.id,side,token,amount_raw:String(amount),out_raw:String(best.output),min_out_raw:String(best.output*BigInt(10000-slippageBps)/10000n),impact_pct:null,slippage_bps:slippageBps,fee_raw:String(best.gas*gasPrice),estimated_gas:String(best.gas),gas_price:String(gasPrice),gas_estimate_source:'SUM_OF_QUOTER_ESTIMATES_PLUS_PER_PATH_OVERHEAD; NOT_SIMULATED',quote_block:block,quoted_at:quoteAt,quote_ms:performance.now()-start,route:[input,...best.hops.map(h=>h.tokenOut)],hops:best.hops,pools:best.hops.map(h=>h.address),candidate_pools:candidatePools,tax_adjusted:false,live_supported:false,live_block:'PAPER_PATH_HAS_NO_VALIDATED_ATOMIC_EXECUTION_OR_INTERMEDIATE_TAX_MODEL',paper_indicative:true};
 }
}
