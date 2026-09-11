import {BSC,ERC20,hex,check,transferDeltas} from '../../core/copy/common.mjs';
import {classifySimulationFailure} from '../../core/copy/simulation-failure.mjs';
import {buildShadowUnsigned,shadowRead,SHADOW_WALLET} from './shadow-compare.mjs';
const strip=({chainId,...tx})=>tx;
const balanceCall=token=>({from:SHADOW_WALLET,to:token,data:ERC20.encodeFunctionData('balanceOf',[SHADOW_WALLET])});
const readBalance=c=>c?.status==='0x1'&&/^0x[0-9a-f]+$/i.test(c.returnData)?BigInt(c.returnData):null;
export function mirrorRawAmount(owned,sold,before){owned=BigInt(owned);sold=BigInt(sold);before=BigInt(before);check(before>0n&&sold>0n&&sold<=before&&owned>0n,'TARGET_EXIT_FRACTION_UNVERIFIED');return sold===before?owned:owned*sold/before;}
export function reverseQuote(q){return {...q,side:q.side==='BUY'?'SELL':'BUY',route:q.route?[...q.route].reverse():q.route,hops:q.hops?[...q.hops].reverse().map(h=>({...h,tokenIn:h.tokenOut,tokenOut:h.tokenIn})):q.hops};}
async function simulate(e,calls,parent){return shadowRead(e,'eth_simulateV1',[{blockStateCalls:[{stateOverrides:{[SHADOW_WALLET]:{balance:hex(10n**19n)}},calls}],validation:false,traceTransfers:true},parent]);}
function requireCalls(result,count,stage){const calls=result?.result?.[0]?.calls;check(calls?.length===count,'SIMULATION_ENVIRONMENT_INCOMPLETE_CALL_SEQUENCE');const failure=calls.find(c=>c.status!=='0x1');if(failure){const error=Error(failure.error?.message??'execution reverted');error.rpc_error=failure.error;error.data=failure.returnData;error.stage=stage;throw error;}return calls;}
function credited(swap){return transferDeltas({logs:swap.logs??[]},SHADOW_WALLET).get(BSC.native)??null;}
// Read-only inventory construction uses a real simulated BUY, never guessed
// ERC20 storage/allowance slots. All attempts start from the same pinned state.
export async function validateSeededSell(e,event,template,c,{seedBnbRaw='2000000000000000',exactAmountRaw=null}={}){
 const start=performance.now(),evidence={version:1,at:Date.now(),source:'EXISTING_TARGET_EVENT_CURRENT_STATE_SIMULATED_BUY_INVENTORY',target_hash:event.hash,token:event.token,target_sold_raw:event.quantity_raw,target_balance_before_raw:event.target_balance_before,exact_paper_amount_requested:exactAmountRaw,signed:false,broadcast:false,token_storage_overridden:false,status:'PREPARING',simulation:{status:'NOT_ATTEMPTED'}};
 try{
  check(event.side==='SELL','TARGET_SELL_REQUIRED');check(template.side==='SELL','SELL_QUOTE_REQUIRED');
  const sold=BigInt(event.quantity_raw),before=BigInt(event.target_balance_before);mirrorRawAmount(1n,sold,before);
  evidence.target_exit_fraction={numerator:String(sold),denominator:String(before),classification:'DERIVED_FROM_RAW_AMOUNTS'};
  const seed={...reverseQuote(template),amount_raw:String(seedBnbRaw),out_raw:'1',min_out_raw:'1',quoted_at:Date.now(),slippage_bps:c.max_slippage_bps};
  // Fail unsupported atomic routes before spending any diagnostic RPC quota.
  const seedProbe=buildShadowUnsigned(seed,c);
  const parent=(await shadowRead(e,'eth_blockNumber',[])).result,gasPrice=BigInt((await shadowRead(e,'eth_gasPrice',[])).result);
  evidence.parent_block=parent;evidence.seed_probe={minimum_one:true,diagnostic_only:true,not_broadcastable_approval:true};
  const balance=balanceCall(event.token),seedResult=await simulate(e,[balance,strip(seedProbe.unsigned_transaction),balance],parent),seedCalls=requireCalls(seedResult,3,'SEED_BUY');
  const initial=readBalance(seedCalls[0]),acquired=readBalance(seedCalls[2]);check(initial===0n&&acquired>0n,'SIMULATION_ENVIRONMENT_SEED_INVENTORY_INVALID');
  const amount=exactAmountRaw===null?mirrorRawAmount(acquired,sold,before):BigInt(exactAmountRaw);check(amount>0n&&amount<=acquired,'SEED_INVENTORY_BELOW_EXACT_PAPER_AMOUNT');
  const buy=buildShadowUnsigned({...seed,out_raw:String(acquired),min_out_raw:String(acquired*BigInt(10000-c.max_slippage_bps)/10000n)},c);
  const sellProbe=buildShadowUnsigned({...template,amount_raw:String(amount),out_raw:'1',min_out_raw:'1',slippage_bps:c.max_slippage_bps,quoted_at:Date.now()},c);
  const approval=strip(sellProbe.approval),prefix=[balance,strip(buy.unsigned_transaction),balance,{from:approval.from,to:approval.to,data:approval.data,value:'0x0'}];
  const probeResult=await simulate(e,[...prefix,strip(sellProbe.unsigned_transaction),balance],parent),probeCalls=requireCalls(probeResult,6,'SELL_NET_QUOTE'),probeSwap=probeCalls[4],net=credited(probeSwap);
  check(net!==null&&net>0n,'SIMULATED_NATIVE_PROCEEDS_NOT_VERIFIED');
  const q={...template,amount_raw:String(amount),out_raw:String(net),min_out_raw:String(net*BigInt(10000-c.max_slippage_bps)/10000n),slippage_bps:c.max_slippage_bps,gas_price:String(gasPrice),quoted_at:Date.now(),quote_block:parent,source:'SIMULATED_NET_NATIVE_PROCEEDS_IN_SEEDED_STATE'};
  const build=buildShadowUnsigned(q,c),gasUsed=BigInt(probeSwap.gasUsed),gasLimit=(gasUsed*120n+99n)/100n,tx={...strip(build.unsigned_transaction),gas:hex(gasLimit)};
  const checked=await simulate(e,[...prefix,tx,balance],parent),calls=requireCalls(checked,6,'FINAL_SELL'),remaining=readBalance(calls[5]),output=credited(calls[4]);
  check(remaining===acquired-amount,'SIMULATION_TOKEN_DEBIT_DOES_NOT_MATCH_INPUT');check(output!==null&&output>=BigInt(q.min_out_raw),'SIMULATED_OUTPUT_BELOW_MINIMUM');
  evidence.status='SIMULATED';evidence.simulation={status:'PASS',method:'eth_simulateV1',inventory_seed:'REAL_CONTRACT_BUY_EXECUTED_ONLY_IN_SIMULATION',initial_token_balance_raw:'0',acquired_raw:String(acquired),sold_raw:String(amount),remaining_raw:String(remaining),native_received_raw:String(output),partial:amount<acquired,full_exit:amount===acquired,gas_used_raw:String(BigInt(calls[4].gasUsed)),gas_limit_verified_raw:String(gasLimit),gas_estimate_source:'ACTUAL_SELL_SIMULATION_PLUS_20_PERCENT_HEADROOM_REVALIDATED',expected_swap_gas_fee_raw:String(gasUsed*gasPrice),approval_gas_used_raw:String(BigInt(calls[3].gasUsed)),provider:checked.provider};
  Object.assign(evidence,{quote:q,unsigned_transaction:build.unsigned_transaction,approval:build.approval,deadline:build.deadline,slippage_bps:q.slippage_bps,unsigned_tx_built:true,seed_buy_amount_raw:String(seedBnbRaw),seed_surplus_raw:exactAmountRaw===null?'0':String(acquired-amount),inventory_note:exactAmountRaw===null?'Exit percentage applied to actual simulated BUY credit; this is not a PAPER fill or new live trade.':'Unsigned SELL preserves exact PAPER input. Extra seed inventory is simulation context, not a copied position.'});
 }catch(error){evidence.status='FAILED';evidence.error=error.message;evidence.simulation={status:'FAIL'};evidence.failure=classifySimulationFailure({message:error.message,error:error.rpc_error,data:error.data},{stage:error.stage??'SELL_VALIDATION',token:event.token,router:template.provider,route:template.route});}
 evidence.total_ms=performance.now()-start;return evidence;
}
