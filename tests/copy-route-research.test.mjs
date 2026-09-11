import test from 'node:test';
import assert from 'node:assert/strict';
import {BscRpc} from '../runtime/copy/rpc.mjs';
import {ShadowReadBudget} from '../runtime/copy/shadow-compare.mjs';
import {benchmarkQuoteRoutes} from '../runtime/copy/route-benchmark.mjs';
test('route research budget covers chain verification and prevents excess wire sends without blocking normal PAPER reads',async()=>{
 const p={id:'p',enabled:true,http_url:'unit'},sent=[],budget=new ShadowReadBudget({limit:2});
 const rpc=new BscRpc([p],{fetcher:async(_u,{body})=>{const {method}=JSON.parse(body);sent.push(method);return new Response(JSON.stringify({result:method==='eth_chainId'?'0x38':'0x1'}));}});
 await rpc.withContext({beforeRequest:()=>budget.take()},()=>rpc.call('eth_blockNumber'));
 await assert.rejects(rpc.withContext({beforeRequest:()=>budget.take()},()=>rpc.call('eth_blockNumber')),/BUDGET/);
 assert.deepEqual(sent,['eth_chainId','eth_blockNumber']);await rpc.call('eth_blockNumber');assert.equal(sent.length,3);
});
test('quote comparison never calls an indicative quote executable or changes PAPER state',async()=>{
 const writes=[],event={hash:'real-fixture-hash',pools:[],candidate_pools:[]};
 const e={store:{get:async()=>({side:'BUY',token:'0x'+'11'.repeat(20),data:JSON.stringify({event,quote:{amount_raw:'1'}})}),setting:async()=>({max_slippage_bps:100}),set:async(k,v)=>writes.push([k,v])},rpc:{withContext:(_c,fn)=>fn()},routes:{providers:[{id:'PANCAKE_V2',quote:async()=>({out_raw:'100',min_out_raw:'99'})},{id:'FLAP_PORTAL',quote:async()=>{throw Error('NO_COMPATIBLE_ROUTE');}}]}};
 const result=await benchmarkQuoteRoutes(e);assert.equal(result.production_selection_changed,false);assert.equal(result.fastest_executable_quote,null);assert.equal(result.best_executable_quote,null);assert.equal(result.rows.length,2);assert.equal(writes.length,1);assert.equal(writes[0][0],'copy_route_research');
});
