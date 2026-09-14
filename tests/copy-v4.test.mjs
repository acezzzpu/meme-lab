import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {minimumOutput,validateProtectedQuote} from '../runtime/copy/protected-quote.mjs';
import {fourSellAmount,FourMemeRoute,FOUR,FOUR_MANAGER,FOUR_HELPER} from '../runtime/copy/four-meme.mjs';
import {v4ReceiptHints,poolId,V4_MANAGER,UniswapV4Route,V4} from '../runtime/copy/uniswap-v4.mjs';
import {decodeEconomicTarget} from '../runtime/copy/economic-decoder.mjs';
import {mergePools} from '../core/copy/common.mjs';
import {hedgeKnownRoute} from '../runtime/copy/route-hedge.mjs';import {selectQuote} from '../runtime/copy/quote-selection.mjs';
const zero='0x'+'0'.repeat(40),wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40);
test('minimum cannot be diagnostic 1, exceed quote, or bypass slippage',()=>{
 assert.equal(minimumOutput(100000n,300),97000n);for(const b of [0,1501,NaN,1.2])assert.throws(()=>minimumOutput(100000n,b));
 for(const min of ['1','96999','100001'])assert.throws(()=>validateProtectedQuote({amount_raw:'2000',out_raw:'100000',min_out_raw:min,slippage_bps:300}));
});
test('Four SELL quantum floors without inventing or deleting remaining inventory',()=>{const n=24210366666105500000000n,a=fourSellAmount(n);assert.equal(a,24210366666105000000000n);assert.equal(n-a,500000000n);assert.equal(a%1000000000n,0n);});
for(const id of ['R1','R2','R3','R4','R5'])test('mandatory receipt '+id+' remains canonical and detects supported protocol hints',async()=>{
 const s=JSON.parse(readFileSync(new URL('./fixtures/v4/'+id+'.json',import.meta.url)));assert.equal(s.receipt.status,'0x1');assert.equal(s.tx.hash,s.receipt.transactionHash);assert.equal(s.block.hash,s.receipt.blockHash);
 const decoded=await decodeEconomicTarget({call:()=>assert.fail('BUY detection needs no extra RPC')},s.tx,s.receipt,s.block,s.tx.from);
 assert.equal(decoded.side,'BUY');const adapter=id==='R3'?'PANCAKE_FLAP_ATOMIC':id==='R5'?'UNISWAP_V4':'FOUR_MEME_TOKEN_MANAGER_V2';const h=decoded.pools.find(h=>h.adapter===adapter);assert.ok(h);
 if(id==='R5'){assert.equal(poolId(h.pool_key),h.pool_id);assert.equal(h.pool_id,'0x7814faabf27089b9db709c14c64b80c6ede56228e01ae6bf38c8985c9e4bb246');}
});
test('v4 singleton preserves distinct pool IDs and rejects forged emitter',()=>{assert.equal(mergePools([{address:V4_MANAGER,pool_id:'a'},{address:V4_MANAGER,pool_id:'b'}]).length,2);assert.deepEqual(v4ReceiptHints({logs:[{address:wallet,topics:[V4.getEvent('Swap').topicHash],data:'0x'}]}),[]);});
test('v4 build carries protected amounts and two explicit SELL approvals without signing',async()=>{
 const key={currency0:zero,currency1:token,fee:70000,tickSpacing:700,hooks:zero};const q={provider:'UNISWAP_V4',side:'SELL',token,recipient:wallet,amount_raw:'1000000',out_raw:'10000',min_out_raw:'9700',slippage_bps:300,pool_key:key,pool_id:poolId(key),quoted_at:Date.now()};const b=await new UniswapV4Route({}).build(q,wallet,{deadline_seconds:30,max_quote_age_ms:1000});assert.equal(b.approvals.length,2);assert.equal(b.tx.value,'0x0');assert.equal(V4.parseTransaction({data:b.tx.data}).args.commands,'0x10');assert.ok(!b.signed);await assert.rejects(()=>new UniswapV4Route({}).build({...q,min_out_raw:'1'},wallet,{max_quote_age_ms:1000}),/UNPROTECTED/);
});
test('known-route hedge starts fallback within bound and cancels losing work',async()=>{
 let slowAborted=false;const slow={id:'FLAP_PORTAL',quote:r=>new Promise((resolve,reject)=>{r.signal.addEventListener('abort',()=>{slowAborted=true;reject(r.signal.reason);});})};const fast={id:'PANCAKE_V2',quote:async()=>({provider:'PANCAKE_V2',impact_pct:0})};const start=performance.now();assert.equal((await selectQuote(hedgeKnownRoute([slow,fast],'FLAP_PORTAL',20),{},{})).provider,'PANCAKE_V2');assert.ok(performance.now()-start<1000);assert.equal(slowAborted,true);
});
