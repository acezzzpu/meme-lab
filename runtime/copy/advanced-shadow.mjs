import {FourMemeRoute} from './four-meme.mjs';
import {UniswapV4Route} from './uniswap-v4.mjs';
import {MixedFlapRoute} from './mixed-flap.mjs';
import {ERC20,hex,check,transferDeltas,BSC,cleanError} from '../../core/copy/common.mjs';
import {classifySimulationFailure} from '../../core/copy/simulation-failure.mjs';
export const advancedProviders=new Set(['FOUR_MEME_TOKEN_MANAGER_V2','UNISWAP_V4','PANCAKE_FLAP_ATOMIC']);
const wallet='0x00000000000000000000000000000000b0bc0f56';
// Inject a budgeted read function. No signer, broadcast, or DB writer is reachable.
export async function advancedShadow(read,event,template,c){
 const start=performance.now(),out={target_hash:event.hash,side:event.side,token:event.token,signed:false,broadcast:false,private_key_used:false,status:'FAILED'};
 try{
  const rpc={call:async(m,p=[])=>read(m,p),contract:async(to,abi,m,args=[],block='latest')=>abi.decodeFunctionResult(m,await read('eth_call',[{to,data:abi.encodeFunctionData(m,args)},block]))};
  const route=template.provider==='UNISWAP_V4'?new UniswapV4Route(rpc):template.provider==='PANCAKE_FLAP_ATOMIC'?new MixedFlapRoute(rpc):new FourMemeRoute(rpc);
  const reuse=template.quote_block&&Date.now()-template.quoted_at>=0&&Date.now()-template.quoted_at<=c.max_quote_age_ms;
  const parent=reuse?template.quote_block:await read('eth_blockNumber',[]),hints=template.provider==='PANCAKE_FLAP_ATOMIC'?[{adapter:template.provider,descriptors:template.descriptors}]:template.pools;
  const request={token:event.token,taker:wallet,slippageBps:template.slippage_bps,blockTag:parent,hints};
  const q=reuse?{...template,recipient:wallet}:await route.quote({...request,side:event.side,amount:BigInt(template.amount_raw)});check(q.side===event.side&&q.token===event.token,'SHADOW_QUOTE_IDENTITY_MISMATCH');const buildStart=performance.now(),build=await route.build(q,wallet,c);out.build_ms=performance.now()-buildStart;out.quote_reused=!!reuse;
  const balance={from:wallet,to:q.token,data:ERC20.encodeFunctionData('balanceOf',[wallet])};let calls,seed=null;
  if(event.side==='BUY')calls=[balance,build.tx,balance];
  else{
   check(BigInt(event.target_balance_before)>0n&&BigInt(event.quantity_raw)>0n&&BigInt(event.quantity_raw)<=BigInt(event.target_balance_before),'TARGET_EXIT_FRACTION_UNVERIFIED');
   out.target_exit_fraction={numerator:event.quantity_raw,denominator:event.target_balance_before};
   seed=await route.quote({...request,side:'BUY',amount:BigInt(q.out_raw)*3n+2000000000000000n});check(BigInt(seed.min_out_raw)>=BigInt(q.amount_raw),'SHADOW_SEED_INVENTORY_INSUFFICIENT');
   const seedBuild=await route.build(seed,wallet,c);const approvals=build.approvals??(build.approval?[{from:wallet,to:q.token,value:'0x0',data:ERC20.encodeFunctionData('approve',[build.approval.spender,q.amount_raw])}]:[]);
   calls=[seedBuild.tx,balance,...approvals,build.tx,balance];
  }
  calls=calls.map(tx=>({...tx,gas:hex(BigInt(q.estimated_gas)*2n)}));
  const simulationStart=performance.now(),overrides={[wallet]:{balance:hex(10n**19n)}};
  const sim=await read('eth_simulateV1',[{blockStateCalls:[{stateOverrides:overrides,calls}],validation:false,traceTransfers:true},parent]);out.simulation_ms=performance.now()-simulationStart;
  const rows=sim?.[0]?.calls;check(rows?.length===calls.length,'SIMULATION_ENVIRONMENT_INCOMPLETE');const bad=rows.find(r=>r.status!=='0x1');if(bad)throw Object.assign(Error(bad.error?.message??'ROUTER_REVERT'),{data:bad.returnData,rpc_error:bad.error});
  const before=BigInt(rows[event.side==='BUY'?0:1].returnData),after=BigInt(rows.at(-1).returnData),swap=rows.at(-2);
  const proceeds=event.side==='BUY'?after-before:transferDeltas({logs:swap.logs??[]},wallet).get(BSC.native);
  check(proceeds!==undefined&&proceeds>=BigInt(q.min_out_raw),'SIMULATED_OUTPUT_BELOW_MINIMUM');if(event.side==='SELL')check(before-after===BigInt(q.amount_raw),'SELL_INVENTORY_MISMATCH');
  if(event.side==='BUY'){out.estimated_gas=String(BigInt(await read('eth_estimateGas',[build.tx,parent,overrides])));check(BigInt(out.estimated_gas)>0n,'SIMULATION_ENVIRONMENT_INVALID_GAS_ESTIMATE');}
  Object.assign(out,{status:'SIMULATED',quote:q,seed_quote:seed,unsigned_transaction:{chainId:56,...build.tx},unsigned_tx_built:true,parent_block:parent,simulated_output_raw:String(proceeds),simulation:{status:'PASS',method:'PROTECTED_QUOTE_AND_SEQUENTIAL_SIMULATION',initial_token_balance_raw:String(before),remaining_token_balance_raw:String(after),gas_used_raw:String(BigInt(swap.gasUsed)),gas_limit_raw:calls.at(-2).gas,token_storage_overridden:false,allowance_storage_overridden:false,minimum_one_used:false},expected_gas_fee_raw:String(BigInt(swap.gasUsed)*BigInt(q.gas_price))});
 }catch(e){out.error=cleanError(e);out.simulation={status:'FAIL'};out.failure=classifySimulationFailure(e.rpc_error??{message:e.message,data:e.data},{token:event.token,route:template.route});}
 return {...out,total_ms:performance.now()-start};
}
