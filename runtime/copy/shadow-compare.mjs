import {BSC,ROUTER,SMART_ROUTER,ERC20,hex,addr,v3Path,check,transferDeltas,cleanError} from '../../core/copy/common.mjs';
import {smartCalls} from '../../core/copy/smart-router.mjs';
import {saveProfile} from '../../core/copy/latency-profile.mjs';
import {FLAP,FLAP_PORTAL,ZERO} from './flap.mjs';

export const SHADOW_WALLET='0x00000000000000000000000000000000b0bc0f56';
export const UNI_BSC_ROUTER='0xb971ef87ede563556b2ed4b1c0b0019111dd85d2';
// This builder consumes the exact PAPER quote and changes neither amount nor
// minimum output. It is isolated from the signer and never touches a ledger.
export function buildShadowUnsigned(q,c,now=Date.now()){
 check(['BUY','SELL'].includes(q.side),'SHADOW_SIDE_INVALID');
 check(BigInt(q.amount_raw)>0n&&BigInt(q.min_out_raw)>0n&&BigInt(q.out_raw)>=BigInt(q.min_out_raw),'SHADOW_AMOUNT_INVALID');
 check(Number.isInteger(q.slippage_bps)&&q.slippage_bps>=0&&q.slippage_bps<=c.max_slippage_bps,'SHADOW_SLIPPAGE_LIMIT');
 const buy=q.side==='BUY',token=addr(q.token),wallet=SHADOW_WALLET,deadline=Math.floor(now/1000)+c.deadline_seconds;
 let to,data,onchainDeadline=deadline;
 if(q.provider==='FLAP_PORTAL'){
  check(q.portal_state?.status===1,'SHADOW_FLAP_NOT_TRADABLE');to=FLAP_PORTAL;
  data=FLAP.encodeFunctionData('swapExactInput',[[buy?ZERO:token,buy?token:ZERO,q.amount_raw,q.min_out_raw,'0x']]);onchainDeadline=null;
 }else if(q.provider==='PANCAKE_V2'||q.provider==='PAPER_DEX_PATH'&&q.hops?.every(h=>h.adapter==='PANCAKE_V2')){
  check(q.route[0]===(buy?BSC.wbnb:token)&&q.route.at(-1)===(buy?token:BSC.wbnb),'SHADOW_PATH_MISMATCH');to=BSC.router;
  data=buy?ROUTER.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',[q.min_out_raw,q.route,wallet,deadline]):ROUTER.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',[q.amount_raw,q.min_out_raw,q.route,wallet,deadline]);
 }else if(q.provider==='PANCAKE_SMART'||q.provider==='PAPER_DEX_PATH'&&q.hops?.every(h=>['PANCAKE_V2','PANCAKE_V3'].includes(h.adapter))){
  to=BSC.smartRouter;data=SMART_ROUTER.encodeFunctionData('multicall',[deadline,smartCalls(q,wallet,deadline)]);
 }else if(q.provider==='PAPER_DEX_PATH'&&q.hops?.length&&q.hops.every(h=>h.adapter==='UNISWAP_V3')){
  const hops=q.hops;check(hops[0].tokenIn===(buy?BSC.wbnb:token)&&hops.at(-1).tokenOut===(buy?token:BSC.wbnb),'SHADOW_PATH_MISMATCH');
  for(let i=1;i<hops.length;i++)check(hops[i-1].tokenOut===hops[i].tokenIn,'SHADOW_PATH_DISCONNECTED');
  to=UNI_BSC_ROUTER;const calls=[SMART_ROUTER.encodeFunctionData('exactInput',[[v3Path([hops[0].tokenIn,...hops.map(h=>h.tokenOut)],hops.map(h=>h.fee)),buy?wallet:to,q.amount_raw,q.min_out_raw]])];
  if(!buy)calls.push(SMART_ROUTER.encodeFunctionData('unwrapWETH9',[q.min_out_raw,wallet]));calls.push(SMART_ROUTER.encodeFunctionData('refundETH'));
  data=SMART_ROUTER.encodeFunctionData('multicall',[deadline,calls]);
 }else throw Error('SHADOW_NO_ATOMIC_BUILDER_FOR_QUOTED_PATH');
 return {unsigned_transaction:{chainId:56,from:wallet,to,data,value:buy?hex(q.amount_raw):'0x0'},approval:buy?null:{from:wallet,to:token,data:ERC20.encodeFunctionData('approve',[to,q.amount_raw]),value:'0x0',amount_raw:q.amount_raw,spender:to},deadline:onchainDeadline,local_expires_at:now+c.deadline_seconds*1000,onchain_deadline_supported:onchainDeadline!==null,quote_age_at_build_ms:now-q.quoted_at,amount_raw:q.amount_raw,min_output_raw:q.min_out_raw,slippage_bps:q.slippage_bps,route:q.route,provider:q.provider};
}

export class ShadowReadBudget {
 constructor({limit=12,now=Date.now}={}){this.limit=limit;this.now=now;this.starts=[];}
 remaining(){this.starts=this.starts.filter(at=>at>this.now()-60000);return Math.max(0,this.limit-this.starts.length);}
 take(){check(this.remaining()>0,'SHADOW_RPC_BUDGET_EXHAUSTED');this.starts.push(this.now());}
}
// Only these read methods are reachable; no signing or broadcast capability.
const READ_METHODS=new Set(['eth_call','eth_estimateGas','eth_simulateV1']);
export async function shadowRead(e,method,params){
 check(READ_METHODS.has(method),'SHADOW_READ_ONLY_METHOD');e.shadowBudget??=new ShadowReadBudget();
 const providers=e.rpc.providers.filter(p=>p.enabled&&e.rpc.verified.has(p.id)&&!['archive','benchmark'].includes(p.role)&&Date.now()>=(e.rpc.cooldown.get(p.id)??0)&&Date.now()>=(e.rpc.unsupported.get(p.id+':'+method)??0));
 let last;
 for(const p of providers.slice(0,2)){
  e.shadowBudget.take();try{return {provider:p.id,result:await e.rpc.withContext({priority:-1,pipeline:'SHADOW_COMPARE'},()=>e.rpc.request(p,method,params,2000))};}
  catch(error){last=error;if(/execution reverted|insufficient funds|allowance|transfer amount exceeds/i.test(error.message))throw error;}
 }
 throw last??Error('SHADOW_NO_AVAILABLE_READ_PROVIDER');
}
export async function compareShadow(e,action,event,q,c){
 const started=performance.now();let evidence={status:'BUILDING',side:action.side,token:event.token,target_hash:event.hash,paper_action_id:action.id,quote:q,classification:'ESTIMATED',unsigned_tx_built:false,simulation:{status:'NOT_ATTEMPTED'},private_key_used:false,signed:false,broadcast:false,position_source:'EXACT_PAPER_INPUT_AMOUNT; NO_SHADOW_FILL_ASSUMED',target_exit_fraction:event.sold_fraction??null},buildMs=null,simulationMs=null;
 try{
  const buildStart=performance.now();let build;try{build=buildShadowUnsigned(q,c);}finally{buildMs=performance.now()-buildStart;}evidence={...evidence,...build,unsigned_tx_built:true,status:'BUILT'};
  await saveProfile(e.store,action.event_id,{shadow:evidence,wall:{shadow_build_at:Date.now()},stages:{SHADOW_BUILD:buildMs}});
  check(Date.now()-q.quoted_at<=c.max_quote_age_ms,'SHADOW_QUOTE_EXPIRED_BEFORE_SIMULATION');
  // Native balance override is explicit, ephemeral simulation state. Token
  // balances/allowances are NOT guessed or fabricated to force a SELL to pass.
  const {chainId,...tx}=build.unsigned_transaction,overrides={[SHADOW_WALLET]:{balance:hex(10n**19n)}};
  const simulationStart=performance.now();
  const approval=build.approval?{from:build.approval.from,to:build.approval.to,data:build.approval.data,value:'0x0'}:null;
  const balanceCall={from:SHADOW_WALLET,to:event.token,data:ERC20.encodeFunctionData('balanceOf',[SHADOW_WALLET])};
  const calls=[balanceCall,...(approval?[approval]:[]),tx,balanceCall];
  const results=await Promise.allSettled([
   shadowRead(e,'eth_simulateV1',[{blockStateCalls:[{stateOverrides:overrides,calls}],validation:false,traceTransfers:true},'latest']),
   shadowRead(e,'eth_estimateGas',[tx,'latest',overrides])
  ]);simulationMs=performance.now()-simulationStart;
  const [call,gas]=results,sequence=call.status==='fulfilled'?call.value.result?.[0]?.calls:null,swap=sequence?.[calls.length-2];let ok=!!swap&&sequence.length===calls.length&&sequence.every(x=>x.status==='0x1');
  evidence.simulation={status:ok?'PASS':'FAIL',method:'eth_simulateV1 + eth_estimateGas',at:Date.now(),state_override:{native_balance_bnb:'10',ephemeral:true,token_storage:false,allowance_storage:false},call:call.status==='fulfilled'?call.value:{error:cleanError(call.reason)},gas:gas.status==='fulfilled'?gas.value:{error:cleanError(gas.reason)},simulation_gas_used:swap?.gasUsed??null,approval_simulated:!!approval,initial_token_balance_raw:sequence?.[0]?.status==='0x1'?String(BigInt(sequence[0].returnData)):null,limitation:action.side==='SELL'?'PAPER inventory does not exist on chain. Sequential approval is simulated; token inventory is not fabricated. A balance failure is a missing simulation-state prerequisite, not proof of unsellability.':null};
  if(gas.status==='fulfilled'){evidence.estimated_gas=String(BigInt(gas.value.result));evidence.expected_gas_fee_raw=String(BigInt(gas.value.result)*BigInt(q.gas_price));evidence.gas_estimate_source='REAL_ETH_ESTIMATE_GAS_WITH_DECLARED_NATIVE_BALANCE_OVERRIDE';}
  if(ok){evidence.simulated_gas_used=String(BigInt(swap.gasUsed));const before=BigInt(sequence[0].returnData),after=BigInt(sequence.at(-1).returnData);evidence.simulated_token_delta_raw=String(after-before);const output=action.side==='BUY'?after-before:transferDeltas({logs:swap.logs??[]},SHADOW_WALLET).get(BSC.native);if(output!==undefined)evidence.simulated_output_raw=String(output);if(output===undefined||output<BigInt(q.min_out_raw)){ok=false;evidence.simulation.status='FAIL';evidence.simulation.output_validation_error=output===undefined?'SIMULATED_NATIVE_PROCEEDS_NOT_VERIFIED':'SIMULATED_OUTPUT_BELOW_MINIMUM';}}
  evidence.status=ok?'SIMULATED':'SIMULATION_FAILED';
 }catch(error){evidence.status=evidence.unsigned_tx_built?'SIMULATION_BLOCKED':'BUILD_FAILED';evidence.error=cleanError(error);}
 const origin=e.eventClocks?.get(event.hash);
 await saveProfile(e.store,action.event_id,{shadow:evidence,wall:{shadow_finished_at:Date.now()},stages:{SHADOW_BUILD:buildMs,SIMULATION:simulationMs,TOTAL_SHADOW_REACTION:origin?.boot===e.boot&&Number.isFinite(origin?.mono)?performance.now()-origin.mono:null,SHADOW_PROCESS:performance.now()-started}});
 return evidence;
}
export function scheduleShadow(e,action,event,q,c){
 if(!e.options.paperOnly||e.options.historicalReplay||event.history||action.mode!=='PAPER'||process.env.BSC_SHADOW_COMPARE==='0')return;
 e.shadowTasks??=new Set();const task=compareShadow(e,action,event,q,c).catch(async error=>{await e.report('SHADOW',cleanError(error)).catch(()=>{});}).finally(()=>e.shadowTasks.delete(task));e.shadowTasks.add(task);
}
