import {decode,hex} from '../../core/copy/common.mjs';

// Account nonce differences independently enumerate outgoing confirmed txs,
// including failed transactions and approvals. No activity is not a 100% pass.
export async function auditCapture(e,{target,fromBlock,toBlock}){
 const [before,after]=await Promise.all([e.rpc.call('eth_getTransactionCount',[target,hex(fromBlock-1)]),e.rpc.call('eth_getTransactionCount',[target,hex(toBlock)])]);
 const first=Number(BigInt(before)),end=Number(BigInt(after)),expected=end-first;
 const rows=await e.store.all("SELECT hash,data FROM copy_source_transactions WHERE status IN ('CONFIRMED','FAILED','INCLUDED_AWAITING_RECEIPT')");
 const seen=new Map();
 for(const r of rows){const tx=decode(r.data).tx;if(tx?.from?.toLowerCase()!==target.toLowerCase()||!tx.blockNumber)continue;const block=Number(BigInt(tx.blockNumber)),nonce=Number(BigInt(tx.nonce));if(block>=fromBlock&&block<=toBlock&&nonce>=first&&nonce<end)seen.set(nonce,r.hash);}
 const missing=[];for(let nonce=first;nonce<end;nonce++)if(!seen.has(nonce))missing.push(nonce);
 const result={at:Date.now(),target,from_block:fromBlock,to_block:toBlock,first_nonce:first,end_nonce_exclusive:end,expected,captured:seen.size,missing_nonces:missing,rate:expected?seen.size/expected:null,status:!expected?'NO_TARGET_ACTIVITY':missing.length?'FAIL':'PASS',scope:'CONFIRMED_OUTGOING_BY_ACCOUNT_NONCE; pending visibility excluded'};
 await e.store.set('copy_capture_audit',result);return result;
}
