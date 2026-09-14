import test from 'node:test';import assert from 'node:assert/strict';
import {advancedShadow} from '../runtime/copy/advanced-shadow.mjs';
import {FOUR} from '../runtime/copy/four-meme.mjs';
const token='0x'+'1'.repeat(40);
for(const acceptable of [true,false])test('advanced SHADOW reuses exact protected PAPER terms; net output '+(acceptable?'passes':'fails'),async()=>{
 const methods=[],q={provider:'FOUR_MEME_TOKEN_MANAGER_V2',side:'BUY',token,amount_raw:'2000000000000000',out_raw:'1000000000000',min_out_raw:'970000000000',quoted_at:Date.now(),quote_block:'0x123',slippage_bps:300,estimated_gas:'450000',gas_price:'1',fee_raw:'450000'};
 const read=async(method,params)=>{methods.push(method);if(method==='eth_estimateGas')return '0x186a0';assert.equal(method,'eth_simulateV1','No unexpected RPC, signer or broadcast method');assert.equal(params[1],q.quote_block);
 const calls=params[0].blockStateCalls[0].calls,decoded=FOUR.parseTransaction({data:calls[1].data});assert.equal(decoded.args.minAmount,BigInt(q.min_out_raw));assert.equal(calls[1].value,'0x71afd498d0000');
 return [{calls:[{status:'0x1',returnData:'0x0'},{status:'0x1',gasUsed:'0x186a0',returnData:'0x'},{status:'0x1',returnData:'0x'+(acceptable?1000000000000n:960000000000n).toString(16)}]}];};
 const r=await advancedShadow(read,{side:'BUY',token,hash:'fixture'},q,{max_quote_age_ms:1000,deadline_seconds:30});
 assert.equal(r.status,acceptable?'SIMULATED':'FAILED');assert.equal(r.quote_reused,true);assert.equal(r.signed,false);assert.equal(r.broadcast,false);assert.equal(methods.length,acceptable?2:1);
 if(acceptable){assert.equal(r.quote.min_out_raw,q.min_out_raw);assert.equal(r.estimated_gas,'100000');assert.ok(r.build_ms>=0);assert.ok(r.simulation_ms>=0);}else assert.equal(r.failure.category,'INSUFFICIENT_OUTPUT');
});
