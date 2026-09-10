import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,solidityPacked} from 'ethers';
import {smartCalls,verifySmartTransaction} from '../core/copy/smart-router.mjs';

// Offline fixtures only: no RPC, signing keys, broadcasts, balances or state changes.
const ROUTER='0x13f4ea83d0bd40e75c8222255bc855a974568dd4';
const WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT='0x55d398326f99059ff775485246999027b3197955';
const TOKEN='0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
const TAKER='0x000000000000000000000000000000000000a11c';
const ATTACKER='0x000000000000000000000000000000000000bad1';
const ABI=new Interface([
 'function multicall(uint256 deadline,bytes[] data) payable returns(bytes[])',
 'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns(uint256)',
 'function swapExactTokensForTokens(uint256,uint256,address[],address) payable returns(uint256)',
 'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
 'function refundETH() payable',
 'function wrapETH(uint256 value) payable',
 'function sweepToken(address token,uint256 amountMinimum,address recipient) payable',
]);
function quote(side='BUY') {
 const forward=[
  {adapter:'PANCAKE_V3',tokenIn:WBNB,tokenOut:USDT,fee:500,pool:'0x0000000000000000000000000000000000000101'},
  {adapter:'PANCAKE_V3',tokenIn:USDT,tokenOut:TOKEN,fee:10000,pool:'0x0000000000000000000000000000000000000102'},
 ];
 return {provider:'PANCAKE_SMART',side,token:TOKEN,hops:side==='BUY'?forward:[...forward].reverse().map(h=>({...h,tokenIn:h.tokenOut,tokenOut:h.tokenIn})),amount_raw:side==='BUY'?'10000000000000000':'2000000000000000000',min_out_raw:side==='BUY'?'1900000000000000000':'8000000000000000',out_raw:side==='BUY'?'2000000000000000000':'9000000000000000',recipient:TAKER,quoted_at:Date.now(),quote_block:'0x1234',slippage_bps:100};
}
const deadline=()=>Math.floor(Date.now()/1000)+30;
const encode=(name,args=[])=>ABI.encodeFunctionData(name,args);
function transaction(q,d,calls=smartCalls(q,TAKER,d)) {
 assert.ok(Array.isArray(calls),'smartCalls must return bytes[]');
 return {from:TAKER,to:ROUTER,chainId:56,data:encode('multicall',[d,calls]),value:q.side==='BUY'?'0x'+BigInt(q.amount_raw).toString(16):'0x0'};
}
function rejected(f,label){let didReject=false;try{didReject=f()===false;}catch{didReject=true;}assert.ok(didReject,label);}
function accepted(u,q,d){assert.notEqual(verifySmartTransaction(u,q,TAKER,d),false);}
const parsed=calls=>calls.map(data=>ABI.parseTransaction({data}));
const allV3Path=q=>solidityPacked(['address',...q.hops.flatMap(()=>['uint24','address'])],[q.hops[0].tokenIn,...q.hops.flatMap(h=>[h.fee,h.tokenOut])]);
function replaceV3(calls,edit){const out=[...calls];const i=out.findIndex(data=>ABI.parseTransaction({data}).name==='exactInput');assert.ok(i>=0);const p=ABI.parseTransaction({data:out[i]}).args[0];out[i]=encode('exactInput',[edit({path:p.path,recipient:p.recipient,amountIn:p.amountIn,amountOutMinimum:p.amountOutMinimum})]);return out;}

test('BUY: fixed native input, canonical router and end recipient/minimum survive encoding',()=>{
 const q=quote(),d=deadline(),calls=smartCalls(q,TAKER,d),u=transaction(q,d,calls);accepted(u,q,d);
 assert.equal(BigInt(u.value),BigInt(q.amount_raw));assert.equal(u.to,ROUTER);
 const swaps=parsed(calls).filter(p=>p.name==='exactInput');assert.ok(swaps.length>=1);
 const last=swaps.at(-1).args[0];assert.equal(last.recipient.toLowerCase(),TAKER);assert.equal(last.amountOutMinimum,BigInt(q.min_out_raw));
 assert.equal(parsed(calls).some(p=>p.name==='unwrapWETH9'),false);
});

test('SELL: zero native input and unwrap pays only taker with protected minimum',()=>{
 const q=quote('SELL'),d=deadline(),calls=smartCalls(q,TAKER,d),u=transaction(q,d,calls);accepted(u,q,d);
 assert.equal(BigInt(u.value),0n);const steps=parsed(calls),unwrap=steps.filter(p=>p.name==='unwrapWETH9');assert.equal(unwrap.length,1);
 assert.equal(unwrap[0].args[0],BigInt(q.min_out_raw));assert.equal(unwrap[0].args[1].toLowerCase(),TAKER);
 const lastSwap=steps.filter(p=>p.name==='exactInput').at(-1);assert.ok([ROUTER,'0x0000000000000000000000000000000000000002'].includes(lastSwap.args[0].recipient.toLowerCase()));
});

test('BUY rejects value inflation and SELL rejects any msg.value',()=>{
 for(const side of ['BUY','SELL']){const q=quote(side),d=deadline(),u=transaction(q,d);u.value='0x'+(BigInt(u.value)+1n).toString(16);rejected(()=>verifySmartTransaction(u,q,TAKER,d),side+' wrong value accepted');}
});

test('rejects changed outer target and non-BSC chain',()=>{
 const q=quote(),d=deadline(),u=transaction(q,d);
 rejected(()=>verifySmartTransaction({...u,to:ATTACKER},q,TAKER,d),'arbitrary router accepted');
 rejected(()=>verifySmartTransaction({...u,chainId:1},q,TAKER,d),'different chain accepted');
});

test('rejects substituted BUY recipient and SELL unwrap recipient',()=>{
 const q=quote(),d=deadline(),calls=replaceV3(smartCalls(q,TAKER,d),p=>({...p,recipient:ATTACKER}));rejected(()=>verifySmartTransaction(transaction(q,d,calls),q,TAKER,d),'BUY recipient hijack accepted');
 const sell=quote('SELL'),sc=[...smartCalls(sell,TAKER,d)];const i=sc.findIndex(x=>ABI.parseTransaction({data:x}).name==='unwrapWETH9');sc[i]=encode('unwrapWETH9',[sell.min_out_raw,ATTACKER]);rejected(()=>verifySmartTransaction(transaction(sell,d,sc),sell,TAKER,d),'SELL unwrap hijack accepted');
});

test('rejects appended arbitrary sweep and nested multicall',()=>{
 const q=quote(),d=deadline(),calls=smartCalls(q,TAKER,d);
 rejected(()=>verifySmartTransaction(transaction(q,d,[...calls,encode('sweepToken',[TOKEN,0,ATTACKER])]),q,TAKER,d),'extra sweep accepted');
 rejected(()=>verifySmartTransaction(transaction(q,d,[encode('multicall',[d,calls])]),q,TAKER,d),'nested multicall accepted');
});

test('rejects substituted expired deadline and a genuinely expired envelope',()=>{
 const q=quote(),d=deadline(),expired=Math.floor(Date.now()/1000)-1,calls=smartCalls(q,TAKER,d),u=transaction(q,d,calls);
 rejected(()=>verifySmartTransaction({...u,data:encode('multicall',[expired,calls])},q,TAKER,d),'deadline substitution accepted');
 rejected(()=>verifySmartTransaction({...u,data:encode('multicall',[expired,calls])},q,TAKER,expired),'expired deadline accepted');
});

test('rejects route substitution, quote amount changes and zero minimum',()=>{
 const q=quote(),d=deadline(),calls=smartCalls(q,TAKER,d);
 const badPath=solidityPacked(['address','uint24','address'],[WBNB,500,ATTACKER]);
 rejected(()=>verifySmartTransaction(transaction(q,d,replaceV3(calls,p=>({...p,path:badPath}))),q,TAKER,d),'substituted path accepted');
 rejected(()=>verifySmartTransaction(transaction(q,d,replaceV3(calls,p=>({...p,amountIn:BigInt(q.amount_raw)+1n}))),q,TAKER,d),'wrong input amount accepted');
 rejected(()=>verifySmartTransaction(transaction(q,d,replaceV3(calls,p=>({...p,amountOutMinimum:0n}))),q,TAKER,d),'zero output minimum accepted');
});

test('exactInput path encoding uses forward token-fee sequence, SELL reverses hops not bytes',()=>{
 const q=quote(),sell=quote('SELL');assert.notEqual(allV3Path(q),allV3Path(sell));
 for(const x of [q,sell]){const swaps=parsed(smartCalls(x,TAKER,deadline())).filter(p=>p.name==='exactInput');
  if(swaps.length===1) assert.equal(swaps[0].args[0].path.toLowerCase(),allV3Path(x).toLowerCase());
  else for(let i=0;i<swaps.length;i++){const h=x.hops[i];assert.equal(swaps[i].args[0].path.toLowerCase(),solidityPacked(['address','uint24','address'],[h.tokenIn,h.fee,h.tokenOut]).toLowerCase());}
 }
});

test('rejects untrusted V3 fee or path fields changed in quote after transaction was built',()=>{
 const q=quote(),d=deadline(),u=transaction(q,d);const changed=structuredClone(q);changed.hops[0].fee=2500;
 rejected(()=>verifySmartTransaction(u,changed,TAKER,d),'quote/transaction hop mismatch accepted');
});
