import {decode,hex} from '../../core/copy/common.mjs';
export async function beginLiveCapture(e,beforeBlock){
 const rows=[];for(const t of e.targets){const nonce=await e.rpc.call('eth_getTransactionCount',[t.address,hex(beforeBlock)]);rows.push({target:t.address,first_nonce:Number(BigInt(nonce))});}
 const baseline={boot:e.boot,from_block:beforeBlock+1,at:Date.now(),targets:rows};e.captureBaseline=baseline;await e.store.set('copy_capture_baseline',baseline);return baseline;
}
export async function checkLiveCapture(e){
 const baseline=e.captureBaseline;if(!baseline)return null;const end=await e.store.setting('copy_live_cursor');if(end<baseline.from_block)return null;
 const sources=await e.store.all("SELECT hash,data FROM copy_source_transactions WHERE status IN ('CONFIRMED','FAILED','INCLUDED_AWAITING_RECEIPT')"),results=[];
 for(const t of baseline.targets){const count=Number(BigInt(await e.rpc.call('eth_getTransactionCount',[t.target,hex(end)]))),seen=new Map();
  for(const s of sources){const tx=decode(s.data).tx;if(tx?.from?.toLowerCase()!==t.target||!tx.blockNumber)continue;const block=Number(BigInt(tx.blockNumber)),nonce=Number(BigInt(tx.nonce));if(block>=baseline.from_block&&block<=end&&nonce>=t.first_nonce&&nonce<count)seen.set(nonce,s.hash);}
  const expected=count-t.first_nonce,missing=[];for(let n=t.first_nonce;n<count&&missing.length<1000;n++)if(!seen.has(n))missing.push(n);
  results.push({target:t.target,from_block:baseline.from_block,to_block:end,first_nonce:t.first_nonce,end_nonce_exclusive:count,expected,captured:seen.size,missing_nonces:missing,rate:expected>0?seen.size/expected:null,status:expected===0?'NO_TARGET_ACTIVITY':expected<0?'NONCE_REORG_OR_PROVIDER_MISMATCH':missing.length?'FAIL':'PASS'});
 }
 const result={at:Date.now(),boot:e.boot,scope:'LIVE_SESSION_CONFIRMED_OUTGOING_ACCOUNT_NONCES; NO_PENDING_VISIBILITY_CLAIM',results};await e.store.set('copy_capture_audit',result);return result;
}
