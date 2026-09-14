import {writeEvidence} from './v4-evidence-io.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {Interface} from 'ethers';
import {MixedFlapRoute,observedDescriptors,OBSERVED_ROUTER} from '../runtime/copy/mixed-flap.mjs';
import {FourMemeRoute} from '../runtime/copy/four-meme.mjs';
import {UniswapV4Route,poolId,V4_MANAGER} from '../runtime/copy/uniswap-v4.mjs';
const ZERO='0x'+'0'.repeat(40),wallet='0x00000000000000000000000000000000b0bc0f56';
const list=JSON.parse(readFileSync('tests/fixtures/v4/five-routing-failures.json')).fixtures;
let id=0;const rpc={call:async(method,params=[])=>{const j=await(await fetch(process.env.V4_FIXTURE_RPC??'https://bsc-rpc.publicnode.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(10000)})).json();if(j.error)throw Error(JSON.stringify(j.error));return j.result;},contract:async(to,abi,method,args=[],block='latest')=>abi.decodeFunctionResult(method,await rpc.call('eth_call',[{to,data:abi.encodeFunctionData(method,args)},block]))};
const erc=new Interface(['function balanceOf(address) view returns (uint256)']);
const results=[];
for(const f of list){const row={id:f.id,hash:f.target_tx,protocol:f.protocol,status:'BLOCKED',signed:false,broadcast:false};try{

 const block='0x'+f.block.toString(16),source=JSON.parse(readFileSync('tests/fixtures/v4/'+f.id+'.json'));
 const key={currency0:ZERO,currency1:f.token,fee:70000,tickSpacing:700,hooks:ZERO};const route=f.id==='R5'?new UniswapV4Route(rpc):f.id==='R3'?new MixedFlapRoute(rpc):new FourMemeRoute(rpc);
 const q=await route.quote({side:'BUY',token:f.token,amount:2000000000000000n,slippageBps:300,taker:wallet,blockTag:block,hints:[{adapter:'PANCAKE_FLAP_ATOMIC',address:OBSERVED_ROUTER,descriptors:observedDescriptors(source.tx)},{adapter:'UNISWAP_V4',address:V4_MANAGER,pool_key:key,pool_id:poolId(key)}]});row.quote=q;
 const build=await route.build(q,wallet,{max_quote_age_ms:10000,deadline_seconds:30});row.build=build;
 // Historical time preserves the unsigned builder deadline without weakening it.
 const time=Math.floor(Date.now()/1000);const calls=[{from:wallet,to:f.token,data:erc.encodeFunctionData('balanceOf',[wallet])},{...build.tx,gas:'0x4c4b40'},{from:wallet,to:f.token,data:erc.encodeFunctionData('balanceOf',[wallet])}];
 const sim=await rpc.call('eth_simulateV1',[{blockStateCalls:[{blockOverrides:{time:'0x'+time.toString(16)},stateOverrides:{[wallet]:{balance:'0x429d069189e0000'}},calls}],validation:false},block]);row.simulation=sim;
 const seq=sim[0].calls;row.credit_raw=String(BigInt(seq[2].returnData)-BigInt(seq[0].returnData));if(seq[1].status!=='0x1'||BigInt(row.credit_raw)<BigInt(q.min_out_raw))throw Error('PROTECTED_OUTPUT_FAILED');row.status='PASS';
 }catch(e){row.error=e.message;}results.push(row);console.log(row.id,row.status,row.error??row.credit_raw);}
writeEvidence('protected-replay',{at:Date.now(),results});if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
