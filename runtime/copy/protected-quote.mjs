import {check} from '../../core/copy/common.mjs';
export function minimumOutput(output,slippageBps){
 const n=BigInt(output);check(n>1n,'OUTPUT_TOO_SMALL');
 check(Number.isInteger(slippageBps)&&slippageBps>0&&slippageBps<=1500,'INVALID_SLIPPAGE');
 const min=n*BigInt(10000-slippageBps)/10000n;check(min>1n,'UNPROTECTED_OUTPUT');return min;
}
export function validateProtectedQuote(q){
 check(BigInt(q.amount_raw)>0n,'INVALID_INPUT');
 const min=minimumOutput(q.out_raw,q.slippage_bps);
 check(BigInt(q.min_out_raw)>=min&&BigInt(q.min_out_raw)<=BigInt(q.out_raw),'UNPROTECTED_OUTPUT');
 return q;
}
