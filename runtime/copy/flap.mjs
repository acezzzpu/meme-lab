import {Interface} from 'ethers';
import {ERC20,TRANSFER,addr,check,hex,transferDeltas,decode,encode} from '../../core/copy/common.mjs';

// Official BNB deployment and ABI, checked 2026-09-10. See docs/FLAP.md.
export const FLAP_PORTAL='0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';
export const ZERO='0x0000000000000000000000000000000000000000';
export const FLAP=new Interface([
 'function getTokenV8Safe(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)',
 'function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount) params) returns (uint256 outputAmount)',
 'function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData) params) payable returns (uint256 outputAmount)',
 'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
 'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)'
]);
const topics=new Set(['TokenSold','TokenBought'].map(n=>FLAP.getEvent(n).topicHash));
export const hasFlapEvent=receipt=>(receipt.logs??[]).some(l=>l.address?.toLowerCase()===FLAP_PORTAL&&topics.has(l.topics?.[0]));

// Receipt-only attribution: authenticate the emitter, then follow the exact token
// amount from/to the watched sender through at most its top-level router.
// This deliberately rejects mixed trades and transfer-tax amount mismatches.
export function flapEvidence(tx,receipt,block,target,token,delta){
 if(receipt.status!=='0x1'||addr(tx.from)!==addr(target)||!delta)return null;
 const wallet=addr(target),router=tx.to?addr(tx.to):null,asset=addr(token),amount=delta>0n?delta:-delta;
 const events=[];const transfers=[];
 for(const [index,log] of (receipt.logs??[]).entries()){
  try{
   if(addr(log.address)===FLAP_PORTAL&&topics.has(log.topics?.[0])){
    const event=FLAP.parseLog(log);if(addr(event.args.token)===asset)events.push({event,log,index});
   }
   if(addr(log.address)===asset&&log.topics?.[0]===TRANSFER){const t=ERC20.parseLog(log);transfers.push({from:addr(t.args.from),to:addr(t.args.to),amount:t.args.value,index});}
  }catch{/* An undecodable log never supplies evidence. */}
 }
 if(events.length!==1)return null;
 const {event,log}=events[0],side=event.name==='TokenBought'?'BUY':'SELL';
 if((side==='BUY')!==(delta>0n)||event.args.amount!==amount||event.args.ts!==BigInt(block.timestamp))return null;
 const participant=addr(event.args.buyer??event.args.seller);
 if(participant!==wallet&&participant!==router)return null;
 const path=side==='SELL'?(participant===wallet?[wallet,FLAP_PORTAL]:[wallet,participant,FLAP_PORTAL]):(participant===wallet?[FLAP_PORTAL,wallet]:[FLAP_PORTAL,participant,wallet]);
 let previous=-1;
 for(let i=0;i<path.length-1;i++){
  const legs=transfers.filter(t=>t.from===path[i]&&t.to===path[i+1]);
  if(legs.length!==1||legs[0].amount!==amount||legs[0].index<=previous)return null;
  previous=legs[0].index;
 }
 return {protocol:'FLAP',portal:FLAP_PORTAL,event:event.name,side,participant,quantity_raw:amount.toString(),event_quote_raw:event.args.eth.toString(),event_fee_raw:event.args.fee.toString(),event_quote_currency:'UNRESOLVED_NOT_ASSUMED_BNB',log_index:log.logIndex,attribution:'OFFICIAL_PORTAL_EVENT_AND_MATCHING_TOKEN_TRANSFERS'};
}

// Reclassify saved observations after upgrading. Never queue an action or replay
// a historical trade, even if the original observation was marked as fresh.
export async function recoverFlapObservations(store){
 const rows=await store.all("SELECT e.id,e.data,t.address target FROM copy_events e JOIN copy_targets t ON t.id=e.target_id WHERE e.kind='UNKNOWN' AND e.status='CONFIRMED' AND e.data LIKE ? LIMIT 500",'%'+FLAP_PORTAL+'%');
 let count=0;
 for(const row of rows){
  const d=decode(row.data),raw=d.raw;if(!raw?.tx||!raw?.receipt||!d.token||!d.target_at)continue;
  try{
   const delta=transferDeltas(raw.receipt,row.target).get(addr(d.token))??0n;
   const proof=flapEvidence(raw.tx,raw.receipt,{timestamp:hex(Math.floor(d.target_at/1000))},row.target,d.token,delta);if(!proof)continue;
   const updated={...d,kind:'OBSERVED_'+proof.side,side:null,observed_side:proof.side,protocol:'FLAP',protocol_evidence:proof,quantity_raw:proof.quantity_raw,reason:'QUOTE_AMOUNT_NOT_VERIFIABLE',history:true,history_reason:'RECLASSIFIED_FROM_STORED_RECEIPT',reclassified_at:Date.now()};
   await store.run("UPDATE copy_events SET kind=?,data=? WHERE id=? AND kind='UNKNOWN'",updated.kind,encode(updated),row.id);count++;
  }catch{/* Keep the original observation if its evidence cannot be decoded. */}
 }
 return count;
}

export class FlapRoute {
 constructor(rpc){this.rpc=rpc;this.id='FLAP_PORTAL';}
 async quote({side,token,amount,slippageBps,taker}){
  check(['BUY','SELL'].includes(side),'FLAP_SIDE_INVALID');
  check(Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<10000,'FLAP_SLIPPAGE_INVALID');
  const start=performance.now(),input=BigInt(amount);check(input>0n,'FLAP_AMOUNT_INVALID');await this.rpc.verify();
  const quoteAt=Date.now(),block=await this.rpc.call('eth_blockNumber');
  const path=side==='BUY'?[ZERO,addr(token)]:[addr(token),ZERO];
  // Both calls use one block. Probe comparison includes protocol fees and taxes;
  // it is not a claim about pool reserves or an independently measured spot price.
  const probe=input/1000n;check(probe>0n,'FLAP_AMOUNT_TOO_SMALL_FOR_IMPACT');
  const [[out],[small],gasPriceHex,[state]]=await Promise.all([
   this.rpc.contract(FLAP_PORTAL,FLAP,'quoteExactInput',[[...path,input]],block),
   this.rpc.contract(FLAP_PORTAL,FLAP,'quoteExactInput',[[...path,probe]],block),
   this.rpc.call('eth_gasPrice'),this.rpc.contract(FLAP_PORTAL,FLAP,'getTokenV8Safe',[token],block)
  ]);
  check(Number(state.status)===1,Number(state.status)===4?'FLAP_TOKEN_MIGRATED_USE_DEX':'FLAP_TOKEN_NOT_TRADABLE');
  check(side!=='BUY'||addr(state.quoteTokenAddress)===ZERO||state.nativeToQuoteSwapEnabled,'FLAP_NATIVE_BUY_NOT_ENABLED');
  check(out>0n&&small>0n,'FLAP_EMPTY_QUOTE');
  const ratio=Number(out*probe)/Number(small*input),impact=Math.max(0,(1-ratio)*100);check(Number.isFinite(impact),'FLAP_IMPACT_UNKNOWN');
  const gasPrice=BigInt(gasPriceHex),gas=450000n;
  return {provider:this.id,side,token:addr(token),amount_raw:input.toString(),out_raw:out.toString(),min_out_raw:(out*BigInt(10000-slippageBps)/10000n).toString(),slippage_bps:slippageBps,impact_pct:impact,impact_source:'SAME_BLOCK_SMALL_QUOTE_COMPARISON',route:path,pools:[],liquidity_bnb:addr(state.quoteTokenAddress)===ZERO?Number(state.reserve)/1e18:null,liquidity_usd:null,liquidity_source:'PORTAL_ACTUAL_QUOTE_RESERVE_NOT_VIRTUAL_LIQUIDITY',reserve_raw:state.reserve.toString(),reserve_quote_token:addr(state.quoteTokenAddress),quote_block:block,gas_price:gasPrice.toString(),estimated_gas:gas.toString(),gas_estimate_source:'CONSERVATIVE_UNTIL_ETH_ESTIMATE_GAS',fee_raw:(gas*gasPrice).toString(),quoted_at:quoteAt,quote_ms:performance.now()-start,recipient:taker,tax_adjusted:true,tax_source:'PORTAL_QUOTE_EXACT_INPUT',portal_state:{status:Number(state.status),quote_token:addr(state.quoteTokenAddress),buy_tax_bps:Number(state.buyTaxRate),sell_tax_bps:Number(state.sellTaxRate)},live_supported:false,live_block:'FLAP_LIVE_ROUNDTRIP_AND_RECONCILIATION_NOT_VALIDATED'};
 }
 async build(q,taker,config){
  check(q.provider===this.id&&q.live_supported===false,'FLAP_QUOTE_INVALID');
  check(Date.now()-q.quoted_at<=config.max_quote_age_ms,'QUOTE_EXPIRED');
  const [state]=await this.rpc.contract(FLAP_PORTAL,FLAP,'getTokenV8Safe',[q.token]);check(Number(state.status)===1,'FLAP_TOKEN_NOT_TRADABLE');
  const buy=q.side==='BUY',path=buy?[ZERO,q.token]:[q.token,ZERO];
  let approval=null;if(!buy){const [allowance]=await this.rpc.contract(q.token,ERC20,'allowance',[taker,FLAP_PORTAL]);if(allowance<BigInt(q.amount_raw))approval={token:q.token,spender:FLAP_PORTAL,amount_raw:q.amount_raw,reset:allowance>0n};}
  return {tx:{from:taker,to:FLAP_PORTAL,data:FLAP.encodeFunctionData('swapExactInput',[[...path,q.amount_raw,q.min_out_raw,'0x']]),value:buy?hex(q.amount_raw):'0x0'},approval,provider:this.id,deadline:null,onchain_deadline:false,live_supported:false};
 }
}
