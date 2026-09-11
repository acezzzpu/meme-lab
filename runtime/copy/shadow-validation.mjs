import {BSC,FACTORY,ERC20,hex,addr,check,cleanError} from '../../core/copy/common.mjs';
import {saveProfile} from '../../core/copy/latency-profile.mjs';
import {classifySimulationFailure} from '../../core/copy/simulation-failure.mjs';
import {buildShadowUnsigned,SHADOW_WALLET,shadowRead,refreshShadowPortal} from './shadow-compare.mjs';
import {validateSeededSell} from './shadow-sell-validation.mjs';
const strip=({chainId,...tx})=>tx;
const balance=token=>({from:SHADOW_WALLET,to:token,data:ERC20.encodeFunctionData('balanceOf',[SHADOW_WALLET])});
function checked(result,n,stage){const rows=result?.result?.[0]?.calls;check(rows?.length===n,'SIMULATION_ENVIRONMENT_INCOMPLETE_CALL_SEQUENCE');const bad=rows.find(x=>x.status!=='0x1');if(bad){const error=Error(bad.error?.message??'execution reverted');Object.assign(error,{data:bad.returnData,rpc_error:bad.error,stage});throw error;}return rows;}
// Only SHADOW may replace an unbuildable indicative route. The replacement is
// authenticated and must pass a real net-output quote plus final simulation.
export async function atomicShadowTemplate(e,q,c){
 try{buildShadowUnsigned(q,c);return q;}catch(error){if(!/NO_ATOMIC_BUILDER/.test(error.message))throw error;}
 const edge=q.hops?.find(h=>h.adapter==='PANCAKE_V2'&&[h.tokenIn,h.tokenOut].includes(q.token));
 check(edge,'SHADOW_NO_ATOMIC_BUILDER_FOR_QUOTED_PATH');const bridge=edge.tokenIn===q.token?edge.tokenOut:edge.tokenIn;
 check(/^0x[0-9a-f]{40}$/.test(bridge??'')&&bridge!==q.token,'SHADOW_NO_ATOMIC_BUILDER_FOR_QUOTED_PATH');
 const path=bridge===BSC.wbnb?[BSC.wbnb,q.token]:[BSC.wbnb,bridge,q.token],pools=[];
 for(let i=1;i<path.length;i++){
  const data=FACTORY.encodeFunctionData('getPair',[path[i-1],path[i]]),r=await shadowRead(e,'eth_call',[{to:BSC.factory,data},'latest']);
  const [pair]=FACTORY.decodeFunctionResult('getPair',r.result);check(BigInt(pair)>0n,'SHADOW_NO_ATOMIC_PANCAKE_V2_ROUTE');pools.push(addr(pair));
 }
 return {...q,provider:'PANCAKE_V2',route:q.side==='BUY'?path:[...path].reverse(),hops:undefined,pools,shadow_route_replacement:{reason:'ORIGINAL_MIXED_ROUTE_HAS_NO_ATOMIC_BUILDER',original_provider:q.provider,original_route:q.route,original_minimum_raw:q.min_out_raw,requires_net_quote_and_simulation:true}};
}
export async function validateNetBuy(e,event,template,c){
 const start=performance.now(),ev={version:2,at:Date.now(),side:'BUY',token:event.token,target_hash:event.hash,status:'PREPARING',simulation:{status:'NOT_ATTEMPTED'},signed:false,broadcast:false,private_key_used:false,paper_quote:template};let router=null;
 try{
  let source=await atomicShadowTemplate(e,template,c);const parent=(await shadowRead(e,'eth_blockNumber',[])).result;source=await refreshShadowPortal(e,source,parent);
  // Minimum one is a read-only quote probe, never final execution calldata.
  const probe=buildShadowUnsigned({...source,amount_raw:template.amount_raw,out_raw:'1',min_out_raw:'1',quoted_at:Date.now()},c),tx=strip(probe.unsigned_transaction),bal=balance(event.token),overrides={[SHADOW_WALLET]:{balance:hex(10n**19n)}};router=tx.to;
  const payload=calls=>[{blockStateCalls:[{stateOverrides:overrides,calls}],validation:false,traceTransfers:true},parent];
  const probeResult=await shadowRead(e,'eth_simulateV1',payload([bal,tx,bal])),rows=checked(probeResult,3,'NET_BUY_QUOTE'),net=BigInt(rows[2].returnData)-BigInt(rows[0].returnData);
  check(net>0n,'SIMULATED_OUTPUT_BELOW_MINIMUM');const q={...source,amount_raw:template.amount_raw,out_raw:String(net),min_out_raw:String(net*BigInt(10000-template.slippage_bps)/10000n),quote_block:parent,quoted_at:Date.now(),quote_source:'ACTUAL_SIMULATED_NET_TOKEN_CREDIT',tax_adjusted:true};
  const build=buildShadowUnsigned(q,c),finalTx=strip(build.unsigned_transaction);
  const [simulation,gas]=await Promise.all([shadowRead(e,'eth_simulateV1',payload([bal,finalTx,bal])),shadowRead(e,'eth_estimateGas',[finalTx,parent,overrides])]);
  const final=checked(simulation,3,'FINAL_BUY'),credit=BigInt(final[2].returnData)-BigInt(final[0].returnData);check(credit>=BigInt(q.min_out_raw),'SIMULATED_OUTPUT_BELOW_MINIMUM');
  const estimated=BigInt(gas.result);check(estimated>0n,'SIMULATION_ENVIRONMENT_INVALID_GAS_ESTIMATE');
  Object.assign(ev,build,{status:'SIMULATED',quote:q,unsigned_tx_built:true,parent_block:parent,estimated_gas:String(estimated),expected_gas_fee_raw:String(estimated*BigInt(q.gas_price)),simulated_output_raw:String(credit),paper_output_gap_pct:(Number(net)/Number(template.out_raw)-1)*100,route_replacement:q.shadow_route_replacement??null,simulation:{status:'PASS',method:'PINNED_NET_QUOTE + eth_simulateV1 + eth_estimateGas',provider:simulation.provider,gas_provider:gas.provider,gas_used_raw:String(BigInt(final[1].gasUsed)),initial_token_balance_raw:String(BigInt(final[0].returnData)),native_balance_override_bnb:'10',token_storage_overridden:false,net_quote_probe_minimum_one:true,final_minimum_uses_unchanged_slippage_bps:template.slippage_bps}});
 }catch(error){ev.status='FAILED';ev.error=cleanError(error);ev.simulation={status:'FAIL'};ev.failure=classifySimulationFailure({message:error.message,error:error.rpc_error,data:error.data},{stage:error.stage??'SHADOW_BUY',router,token:event.token,route:template.route});}
 ev.total_ms=performance.now()-start;return ev;
}
export async function compareValidatedShadow(e,action,event,q,c){
 const started=performance.now();let result;
 if(action.side==='BUY')result=await validateNetBuy(e,event,q,c);
 else try{const template=await atomicShadowTemplate(e,q,c);result=await validateSeededSell(e,event,template,c,{exactAmountRaw:q.amount_raw,seedBnbRaw:String(BigInt(q.out_raw)*2n)});}
 catch(error){result={status:'FAILED',side:'SELL',target_hash:event.hash,token:event.token,error:cleanError(error),failure:classifySimulationFailure(error,{stage:'SHADOW_SELL',token:event.token,route:q.route}),simulation:{status:'FAIL'},signed:false,broadcast:false};}
 const origin=e.eventClocks?.get(event.hash);result={...result,side:action.side,paper_action_id:action.id,paper_quote:q,private_key_used:false,signed:false,broadcast:false};
 await saveProfile(e.store,action.event_id,{shadow:result,wall:{shadow_finished_at:Date.now()},stages:{SHADOW_PROCESS:performance.now()-started,TOTAL_SHADOW_REACTION:origin?.boot===e.boot&&Number.isFinite(origin?.mono)?performance.now()-origin.mono:null}});return result;
}
