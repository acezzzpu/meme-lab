import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diagnose,saveDiagnostic,CASE} from '../scripts/diagnose-copy-bnb.mjs';
import {BSC,PAIR,FACTORY} from '../core/copy/common.mjs';

const otherFactory='0x1111111111111111111111111111111111111111';
function provider({chain='0x38',factory=otherFactory,registered=CASE.pool,traceError=true,wrongId=false}={}){
 const calls=[];return {calls,fetcher:async(url,options)=>{
  assert.equal(url,CASE.endpoint);assert.equal(options.method,'POST');const q=JSON.parse(options.body);calls.push(q);
  let result,error;if(q.method==='eth_chainId')result=chain;
  else if(q.method==='eth_blockNumber')result='0x736b055';
  else if(q.method==='eth_getCode')result='0x60016000';
  else if(q.method==='eth_call'){
   const tx=q.params[0],selector=tx.data.slice(0,10);
   if(tx.to===factory){assert.equal(selector,FACTORY.getFunction('getPair').selector);result=FACTORY.encodeFunctionResult('getPair',[registered]);}
   else{assert.equal(tx.to,CASE.pool);const fn=PAIR.getFunction(selector);assert.ok(['token0','token1','factory'].includes(fn.name));result=PAIR.encodeFunctionResult(fn.name,[fn.name==='token0'?CASE.token:fn.name==='token1'?BSC.wbnb:factory]);}
  }else if(q.method==='debug_traceTransaction'){
   assert.equal(q.params[0],CASE.traceTransaction);assert.equal(q.params[1].tracer,'callTracer');
   if(traceError)error={code:-32000,message:'missing trie node'};
   else result={type:'CALL',from:CASE.target,to:otherFactory,value:'0x0',calls:[{type:'CALL',from:otherFactory,to:CASE.target,value:'0x64'},{type:'DELEGATECALL',from:otherFactory,to:CASE.target,value:'0x64'},{type:'CALL',from:otherFactory,to:CASE.target,value:'0xff',error:'reverted'}]};
  }else throw Error('Non-read operation attempted: '+q.method);
  return Response.json({jsonrpc:'2.0',id:wrongId?q.id+1:q.id,...error?{error}:{result}});
 }};
}

test('probe identifies a registered foreign factory without enabling it and preserves trace failure',async()=>{
 const p=provider();const report=await diagnose({fetcher:p.fetcher});
 assert.equal(report.status,'DIAGNOSTIC_COMPLETED');assert.equal(report.pools.length,2);
 for(const pool of report.pools){assert.equal(pool.classification,'FACTORY_NOT_SUPPORTED_BY_CURRENT_ENGINE');assert.equal(pool.registered.value,CASE.pool);assert.equal(pool.code.bytes,4);}
 assert.match(report.trace.error,/missing trie node/);assert.equal(report.transactions_sent,0);
 assert.equal(p.calls.length,13);assert.ok(p.calls.every(c=>['eth_chainId','eth_blockNumber','eth_getCode','eth_call','debug_traceTransaction'].includes(c.method)));
});
test('a factory registry mismatch is not treated as verified even for Pancake',async()=>{
 const p=provider({factory:BSC.factory,registered:'0x2222222222222222222222222222222222222222'});const report=await diagnose({fetcher:p.fetcher});
 assert.ok(report.pools.every(p=>p.classification==='FACTORY_REGISTRY_MISMATCH'));
});
test('wrong network and mismatched RPC response stop before any pool or trace request',async()=>{
 for(const options of [{chain:'0x1'},{wrongId:true}]){const p=provider(options);const report=await diagnose({fetcher:p.fetcher});assert.equal(p.calls.length,1);assert.ok(['WRONG_CHAIN','RPC_UNAVAILABLE'].includes(report.status));assert.equal(report.pools.length,0);}
});
test('native trace counts only successful value-carrying calls and does not imply a trade fill',async()=>{
 const p=provider({factory:BSC.factory,traceError:false});const report=await diagnose({fetcher:p.fetcher});
 assert.ok(report.pools.every(p=>p.classification==='PANCAKE_V2_FACTORY_VERIFIED'));
 assert.equal(report.trace.target_native_net_raw,'100');assert.equal(report.transactions_sent,0);assert.equal(report.trace.calls,4);
});
test('offline RPC still produces a readable diagnostic file and does not touch project state',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'bnb-diagnostic-'));t.after(()=>rm(directory,{recursive:true,force:true}));let requests=0;
 const result=await saveDiagnostic({directory,fetcher:async()=>{requests++;throw Error('TEST_TIMEOUT');}});
 const saved=JSON.parse(await readFile(result.path,'utf8'));assert.equal(saved.status,'RPC_UNAVAILABLE');assert.match(saved.chain.error,/TEST_TIMEOUT/);assert.equal(requests,1);assert.equal(saved.transactions_sent,0);assert.match(result.path,/diagnostico-bnb-.*\.json$/);
});
