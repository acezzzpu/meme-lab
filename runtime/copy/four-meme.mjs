import {Interface} from 'ethers';
import {addr,check,hex,ERC20} from '../../core/copy/common.mjs';
import {ZERO} from './flap.mjs';
import {minimumOutput,validateProtectedQuote} from './protected-quote.mjs';
export const FOUR_MANAGER='0x5c952063c7fc8610ffdb798152d69f0b9550762b';
export const FOUR_HELPER='0xf251f83e40a78868fcfa3fa4599dad6494e46034';
export const FOUR_QUANTUM=1000000000n;
export function fourSellAmount(amount){return BigInt(amount)/FOUR_QUANTUM*FOUR_QUANTUM;}
// Primary ABI: four-meme-community/four-meme-ai integration scripts, 2026-09-14.
export const FOUR=new Interface([
 'function getTokenInfo(address) view returns (uint256 version,address manager,address quote,uint256 price,uint256 feeRate,uint256 minFee,uint256 launch,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)',
 'function tryBuy(address,uint256,uint256) view returns (address manager,address quote,uint256 amount,uint256 cost,uint256 fee,uint256 msgValue,uint256 approval,uint256 funds)',
 'function trySell(address,uint256) view returns (address manager,address quote,uint256 funds,uint256 fee)',
 'function buyTokenAMAP(address token,uint256 funds,uint256 minAmount) payable',
 'function sellToken(uint256 origin,address token,uint256 amount,uint256 minFunds)'
]);
export class FourMemeRoute {
 constructor(rpc){this.rpc=rpc;this.id='FOUR_MEME_TOKEN_MANAGER_V2';}
 async quote({side,token,amount,slippageBps,taker,blockTag}){
  check(['BUY','SELL'].includes(side),'INVALID_SIDE');token=addr(token);const start=performance.now(),requested=BigInt(amount),input=side==='SELL'?fourSellAmount(requested):requested;check(input>0n,'FOUR_AMOUNT_BELOW_QUANTUM');
  const block=blockTag??await this.rpc.call('eth_blockNumber');
  const [info,gasPriceRaw]=await Promise.all([this.rpc.contract(FOUR_HELPER,FOUR,'getTokenInfo',[token],block),this.rpc.call('eth_gasPrice')]);
  check(info.version===2n&&addr(info.manager)===FOUR_MANAGER,'FOUR_MANAGER_MISMATCH');check(addr(info.quote)===ZERO,'FOUR_NON_NATIVE_QUOTE');check(!info.liquidityAdded,'FOUR_MIGRATED');
  const read=n=>this.rpc.contract(FOUR_HELPER,FOUR,side==='BUY'?'tryBuy':'trySell',side==='BUY'?[token,0n,n]:[token,n],block);
  const small=input/100n||1n;const [full,probe]=await Promise.all([read(input),read(small)]);
  for(const q of [full,probe])check(addr(q.manager)===FOUR_MANAGER&&addr(q.quote)===ZERO,'FOUR_QUOTE_IDENTITY');
  const out=side==='BUY'?full.amount:full.funds-full.fee,probeOut=side==='BUY'?probe.amount:probe.funds-probe.fee;
  if(side==='BUY')check(full.msgValue===input&&full.approval===0n,'FOUR_INPUT_REFUND_OR_APPROVAL_UNMODELED');
  check(probeOut>0n,'FOUR_IMPACT_UNAVAILABLE');const gas=450000n,gp=BigInt(gasPriceRaw);
  let min=minimumOutput(out,slippageBps);if(side==='BUY')min=(min+FOUR_QUANTUM-1n)/FOUR_QUANTUM*FOUR_QUANTUM;check(min<=out,'FOUR_MINIMUM_EXCEEDS_OUTPUT');
  return {provider:this.id,side,token,requested_amount_raw:String(requested),amount_raw:String(input),unspent_token_dust_raw:String(requested-input),out_raw:String(out),min_out_raw:String(min),slippage_bps:slippageBps,impact_pct:Math.max(0,(1-Number(out)*Number(small)/(Number(probeOut)*Number(input)))*100),route:side==='BUY'?[ZERO,token]:[token,ZERO],pools:[],quote_block:block,gas_price:String(gp),estimated_gas:String(gas),fee_raw:String(gas*gp),protocol_fee_raw:String(full.fee),protocol_fee_in_output:true,quoted_at:Date.now(),quote_ms:performance.now()-start,recipient:taker,tax_adjusted:false,liquidity_bnb:Number(info.funds)/1e18,live_supported:false,live_block:'FOUR_PROTECTED_HISTORICAL_ROUNDTRIP_NOT_VALIDATED'};
 }
 async build(q,taker,config){
  validateProtectedQuote(q);check(q.provider===this.id&&addr(q.recipient)===addr(taker),'QUOTE_IDENTITY_MISMATCH');check(Date.now()-q.quoted_at<=config.max_quote_age_ms,'QUOTE_EXPIRED');
  check(['BUY','SELL'].includes(q.side),'INVALID_SIDE');check(BigInt(q.side==='BUY'?q.min_out_raw:q.amount_raw)%FOUR_QUANTUM===0n,'FOUR_QUANTUM_MISMATCH');
  const buy=q.side==='BUY';let approval=null;if(!buy){const [a]=await this.rpc.contract(q.token,ERC20,'allowance',[taker,FOUR_MANAGER]);if(a<BigInt(q.amount_raw))approval={token:q.token,spender:FOUR_MANAGER,amount_raw:q.amount_raw,reset:a>0n};}
  return {provider:this.id,tx:{from:taker,to:FOUR_MANAGER,value:buy?hex(q.amount_raw):'0x0',data:FOUR.encodeFunctionData(buy?'buyTokenAMAP':'sellToken',buy?[q.token,q.amount_raw,q.min_out_raw]:[0,q.token,q.amount_raw,q.min_out_raw])},approval,deadline:null,onchain_deadline:false,live_supported:false};
 }
}
