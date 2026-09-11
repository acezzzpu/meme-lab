import test from 'node:test';
import assert from 'node:assert/strict';
import {candidatePriority,selectQuote} from '../runtime/copy/quote-selection.mjs';
import {BscRpc} from '../runtime/copy/rpc.mjs';

test('only speculative V3 discovery yields RPC priority to observed receipt pools',()=>{
 const p={id:'PANCAKE_SMART'},request={paper:true,candidatePools:[{address:'pool'}]};assert.equal(candidatePriority(p,request,2),-1);
 assert.equal(candidatePriority(p,{...request,hints:[{token0:'a',token1:'b'}]},2),2);assert.equal(candidatePriority(p,{},2),2);assert.equal(candidatePriority({id:'PAPER_DEX_PATH'},request,2),2);
});
test('observed-path RPC finishes ahead of speculative backlog with the same validated quote, and fallback remains usable',async()=>{
 const rpc=new BscRpc([{id:'p',enabled:true,http_url:'p',requests_per_second:100}],{maxConcurrent:2,fetcher:async(_u,{body})=>new Response(JSON.stringify({result:JSON.parse(body).method==='eth_chainId'?'0x38':'0x1'}))});rpc.verified.add('p');
 const q={provider:'PAPER_DEX_PATH',out_raw:'100',min_out_raw:'99',impact_pct:0,quoted_at:Date.now()},request={candidatePools:[{address:'pool'}],paper:true};let validated=0;
 const providers=[{id:'PANCAKE_SMART',quote:async()=>{await Promise.all(Array.from({length:12},()=>rpc.call('speculative')));throw Error('NO_ROUTE');}},{id:'PAPER_DEX_PATH',quote:async()=>{await rpc.call('observed-path');return q;}}];
 const result=await selectQuote(providers,request,{rpc,priority:2,validate:raw=>{validated++;assert.equal(raw.min_out_raw,'99');return raw;}});assert.equal(result.provider,'PAPER_DEX_PATH');assert.equal(validated,1);assert.ok(rpc.telemetry.snapshot(rpc.providers).providers[0].requests<13,'unused speculative reads cancel before reaching the wire');
 const fallback=await selectQuote([{id:'PAPER_DEX_PATH',quote:async()=>{throw Error('POOL_UNAVAILABLE');}},{id:'PANCAKE_SMART',quote:async()=>({...q,provider:'PANCAKE_SMART'})}],request,{rpc,priority:2});assert.equal(fallback.provider,'PANCAKE_SMART');
});
