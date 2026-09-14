import {Interface} from 'ethers';
import {BSC,FACTORY,V3FACTORY,ROUTER,QUOTER_V3,ERC20,v3Path,addr,hex,check} from '../../core/copy/common.mjs';
import {FLAP,FLAP_PORTAL,ZERO} from './flap.mjs';
import {minimumOutput,validateProtectedQuote} from './protected-quote.mjs';
export const OBSERVED_ROUTER='0x1de460f363af910f51726def188f9004276bf4bc';
export const OBSERVED_ABI=new Interface(['function swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],address,uint256,uint256,uint256) payable']);
export function observedDescriptors(tx){if(addr(tx.to)!==OBSERVED_ROUTER)return null;try{return OBSERVED_ABI.parseTransaction({data:tx.input??tx.data}).args[0].map(h=>Array.from(h,v=>typeof v==='bigint'?v.toString():v));}catch{return null;}}
export class MixedFlapRoute {
 constructor(rpc){this.rpc=rpc;this.id='PANCAKE_FLAP_ATOMIC';}
 async quote({side,token,amount,slippageBps,taker,hints=[],blockTag}){
  const start=performance.now();check(side==='BUY','MIXED_REVERSE_PATH_NOT_VALIDATED');const h=hints.find(h=>h.adapter===this.id),hops=h?.descriptors;check(hops?.length>=2&&hops.length<=4,'MIXED_PATH_REQUIRED');
  check(addr(hops[0][1])===BSC.wbnb&&addr(hops.at(-1)[2])===addr(token)&&Number(hops.at(-1)[0])===6,'MIXED_ENDPOINTS');
  for(let i=0;i<hops.length;i++){const x=hops[i];check(addr(x[6])===ZERO&&x[7]==='0x'&&addr(x[8])===ZERO&&BigInt(x[9])===0n,'MIXED_EXTENSION_NOT_VALIDATED');if(i)check(addr(hops[i-1][2])===addr(x[1]),'MIXED_DISCONNECTED');}
  const block=blockTag??await this.rpc.call('eth_blockNumber');
  await Promise.all(hops.slice(0,-1).map(async x=>{check([0,1].includes(Number(x[0])),'MIXED_HOP_UNSUPPORTED');const [pool]=await this.rpc.contract(Number(x[0])===0?BSC.factory:BSC.v3factory,Number(x[0])===0?FACTORY:V3FACTORY,Number(x[0])===0?'getPair':'getPool',Number(x[0])===0?[x[1],x[2]]:[x[1],x[2],x[4]],block);check(addr(pool)===addr(x[3]),'MIXED_POOL_AUTHENTICATION_FAILED');}));
  const [portal]=await this.rpc.contract(FLAP_PORTAL,FLAP,'getTokenV8Safe',[token],block);check(Number(portal.status)===1&&addr(portal.quoteTokenAddress)===addr(hops.at(-1)[1]),'MIXED_PORTAL_QUOTE_MISMATCH');
  // State-dependent quotes remain fresh. No target amount-out is reused.
  const quote=async input=>{let n=input;for(const x of hops){if(Number(x[0])===0){const [a]=await this.rpc.contract(BSC.router,ROUTER,'getAmountsOut',[n,[x[1],x[2]]],block);n=a.at(-1);}else if(Number(x[0])===1){[n]=await this.rpc.contract(BSC.quoterV3,QUOTER_V3,'quoteExactInput',[v3Path([x[1],x[2]],[Number(x[4])]),n],block);}else{[n]=await this.rpc.contract(FLAP_PORTAL,FLAP,'quoteExactInput',[[x[1],x[2],n]],block);}}return n;};
  const input=BigInt(amount),small=input/100n||1n;const [out,probe,gp]=await Promise.all([quote(input),quote(small),this.rpc.call('eth_gasPrice')]);check(probe>0n,'MIXED_IMPACT_UNKNOWN');
  const q={provider:this.id,side,token:addr(token),amount_raw:String(input),out_raw:String(out),min_out_raw:String(minimumOutput(out,slippageBps)),slippage_bps:slippageBps,impact_pct:Math.max(0,(1-Number(out)*Number(small)/(Number(probe)*Number(input)))*100),descriptors:hops,route:[hops[0][1],...hops.map(x=>x[2])],pools:hops.map(x=>({address:addr(x[3])})),quote_block:block,gas_price:String(BigInt(gp)),estimated_gas:'850000',fee_raw:String(BigInt(gp)*850000n),quoted_at:Date.now(),quote_ms:performance.now()-start,recipient:taker,tax_adjusted:false,live_supported:false,live_block:'OBSERVED_ROUTER_IMPLEMENTATION_NOT_LIVE_VALIDATED'};
  const built=await this.build(q,taker,{max_quote_age_ms:10000,deadline_seconds:30});
  const balance={from:taker,to:token,data:ERC20.encodeFunctionData('balanceOf',[taker])};
  const sim=await this.rpc.call('eth_simulateV1',[{blockStateCalls:[{blockOverrides:{time:hex(Math.floor(Date.now()/1000))},stateOverrides:{[taker]:{balance:hex(input+10n**18n)}},calls:[balance,{...built.tx,gas:'0x4c4b40'},balance]}],validation:false},block]);
  const calls=sim?.[0]?.calls;check(calls?.length===3&&calls.every(c=>c.status==='0x1'),'MIXED_PROTECTED_SIMULATION_FAILED');const net=BigInt(calls[2].returnData)-BigInt(calls[0].returnData);check(net>=BigInt(q.min_out_raw),'MIXED_NET_OUTPUT_BELOW_MINIMUM');
  return {...q,gross_hop_output_raw:q.out_raw,out_raw:String(net),min_out_raw:String(minimumOutput(net,slippageBps)),impact_pct:Math.max(q.impact_pct,(1-Number(net)*Number(small)/(Number(probe)*Number(input)))*100),tax_adjusted:true,tax_source:'SAME_BLOCK_SEQUENTIAL_NET_BALANCE_SIMULATION',simulation_gas_used:calls[1].gasUsed,quote_ms:performance.now()-start};
 }
 async build(q,taker,config){validateProtectedQuote(q);check(q.provider===this.id&&q.side==='BUY'&&addr(q.recipient)===addr(taker),'MIXED_QUOTE_MISMATCH');check(Date.now()-q.quoted_at<=config.max_quote_age_ms,'QUOTE_EXPIRED');const deadline=Math.floor(Date.now()/1000)+config.deadline_seconds;return {provider:this.id,tx:{from:taker,to:OBSERVED_ROUTER,value:hex(q.amount_raw),data:OBSERVED_ABI.encodeFunctionData('swap',[q.descriptors,ZERO,q.amount_raw,q.min_out_raw,deadline])},approval:null,deadline,live_supported:false};}
}

