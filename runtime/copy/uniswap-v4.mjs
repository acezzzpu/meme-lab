import {Interface,AbiCoder,keccak256} from 'ethers';
import {addr,check,hex,ERC20} from '../../core/copy/common.mjs';
import {ZERO} from './flap.mjs';
import {minimumOutput,validateProtectedQuote} from './protected-quote.mjs';
export const V4_MANAGER='0x28e2ea090877bf75740558f6bfb36a5ffee9e9df';
export const V4_QUOTER='0x9f75dd27d6664c475b90e105573e550ff69437b0';
export const V4_ROUTER='0x1906c1d672b88cd1b9ac7593301ca990f94eae07';
export const PERMIT2='0x000000000022d473030f116ddee9f6b43ac78ba3';
const PERMIT=new Interface(['function approve(address token,address spender,uint160 amount,uint48 expiration)']);
const KEY='(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const coder=AbiCoder.defaultAbiCoder();
export const V4=new Interface([
 `function quoteExactInputSingle((${KEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`,
 'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
 'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
 'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)'
]);
export function poolId(key){return keccak256(coder.encode([KEY],[key]));}
export function v4ReceiptHints(receipt){return (receipt.logs??[]).filter(l=>l.address?.toLowerCase()===V4_MANAGER).flatMap(l=>{try{const p=V4.parseLog(l);if(p?.name==='Initialize'){const a=p.args,key={currency0:addr(a.currency0),currency1:addr(a.currency1),fee:Number(a.fee),tickSpacing:Number(a.tickSpacing),hooks:addr(a.hooks)};check(poolId(key)===a.id,'POOL_ID_MISMATCH');return [{address:V4_MANAGER,adapter:'UNISWAP_V4',pool_id:a.id,pool_key:key}];}if(p?.name==='Swap')return [{address:V4_MANAGER,adapter:'UNISWAP_V4',pool_id:p.args.id}];}catch{}return [];});}
export class UniswapV4Route {
 constructor(rpc){this.rpc=rpc;this.id='UNISWAP_V4';}
 async quote({side,token,amount,slippageBps,taker,hints=[],blockTag}){
  const start=performance.now();token=addr(token);check(['BUY','SELL'].includes(side),'INVALID_SIDE');
  const hint=hints.find(h=>h.adapter===this.id&&h.pool_key);check(hint,'V4_POOL_KEY_UNRESOLVED');const key=hint.pool_key;
  check(poolId(key)===hint.pool_id,'V4_POOL_ID_MISMATCH');check(addr(key.hooks)===ZERO,'V4_HOOK_REQUIRES_VALIDATION');
  check(addr(key.currency0)===ZERO&&addr(key.currency1)===token,'V4_NATIVE_PAIR_REQUIRED');
  const input=BigInt(amount);check(input>0n&&input<(1n<<128n),'V4_INVALID_AMOUNT');const block=blockTag??await this.rpc.call('eth_blockNumber');const small=input/100n||1n;
  const quote=n=>this.rpc.contract(V4_QUOTER,V4,'quoteExactInputSingle',[[key,side==='BUY',n,'0x']],block);
  const [[out,estimate],[probe],gp]=await Promise.all([quote(input),quote(small),this.rpc.call('eth_gasPrice')]);check(probe>0n,'V4_IMPACT_UNKNOWN');
  const gas=BigInt(estimate)+150000n;return {provider:this.id,side,token,amount_raw:String(input),out_raw:String(out),min_out_raw:String(minimumOutput(out,slippageBps)),slippage_bps:slippageBps,impact_pct:Math.max(0,(1-Number(out)*Number(small)/(Number(probe)*Number(input)))*100),route:side==='BUY'?[ZERO,token]:[token,ZERO],pools:[hint],pool_key:key,pool_id:hint.pool_id,quote_block:block,gas_price:String(BigInt(gp)),estimated_gas:String(gas),fee_raw:String(gas*BigInt(gp)),quoted_at:Date.now(),quote_ms:performance.now()-start,recipient:taker,tax_adjusted:false,liquidity_bnb:null,live_supported:false,live_block:'V4_PROTECTED_HISTORICAL_ROUNDTRIP_NOT_VALIDATED'};
 }
 async build(q,taker,config){
  validateProtectedQuote(q);check(q.provider===this.id&&poolId(q.pool_key)===q.pool_id&&addr(q.recipient)===addr(taker),'V4_QUOTE_MISMATCH');check(Date.now()-q.quoted_at<=config.max_quote_age_ms,'QUOTE_EXPIRED');
  check(addr(q.pool_key.hooks)===ZERO,'V4_HOOK_REQUIRES_VALIDATION');check(addr(q.pool_key.currency0)===ZERO&&addr(q.pool_key.currency1)===addr(q.token),'V4_NATIVE_PAIR_REQUIRED');
  const buy=q.side==='BUY';check(buy||q.side==='SELL','INVALID_SIDE');
  const actions='0x060c0f',params=[coder.encode([`(${KEY},bool,uint128,uint128,bytes)`],[[q.pool_key,buy,q.amount_raw,q.min_out_raw,'0x']]),coder.encode(['address','uint256'],[buy?ZERO:q.token,q.amount_raw]),coder.encode(['address','uint256'],[buy?q.token:ZERO,q.min_out_raw])];
  const deadline=Math.floor(Date.now()/1000)+config.deadline_seconds;
  const approvals=buy?[]:[{from:taker,to:q.token,value:'0x0',data:ERC20.encodeFunctionData('approve',[PERMIT2,q.amount_raw])},{from:taker,to:PERMIT2,value:'0x0',data:PERMIT.encodeFunctionData('approve',[q.token,V4_ROUTER,q.amount_raw,deadline])}];
  return {provider:this.id,tx:{from:taker,to:V4_ROUTER,value:buy?hex(q.amount_raw):'0x0',data:V4.encodeFunctionData('execute',['0x10',[coder.encode(['bytes','bytes[]'],[actions,params])],deadline])},approval:null,approvals,deadline,live_supported:false};
 }
}
