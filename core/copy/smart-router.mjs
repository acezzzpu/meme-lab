import {BSC,SMART_ROUTER,v3Path,addr,check} from './common.mjs';
// Only independently authenticated Pancake V2/V3 hops. Never use the trader's calldata.
export function smartCalls(q,taker,deadline){
 const hops=q.hops;check(Array.isArray(hops)&&hops.length>0&&hops.length<=4,'SMART_ROUTE_REQUIRED');
 const buy=q.side==='BUY';check(hops[0].tokenIn===(buy?BSC.wbnb:q.token)&&hops.at(-1).tokenOut===(buy?q.token:BSC.wbnb),'SMART_ASSETS_MISMATCH');
 const seen=new Set([hops[0].tokenIn]);for(let i=0;i<hops.length;i++){const h=hops[i];check(['PANCAKE_V2','PANCAKE_V3'].includes(h.adapter),'SMART_ADAPTER_NOT_ALLOWED');check(!seen.has(h.tokenOut),'SMART_ROUTE_CYCLE');seen.add(h.tokenOut);if(i)check(hops[i-1].tokenOut===h.tokenIn,'SMART_ROUTE_DISCONNECTED');if(h.adapter==='PANCAKE_V3')check([100,500,2500,10000].includes(h.fee),'SMART_FEE_NOT_ALLOWED');}
 check(BigInt(q.amount_raw)>0n&&BigInt(q.min_out_raw)>0n,'SMART_AMOUNT_INVALID');const groups=[];for(const h of hops){let g=groups.at(-1);if(!g||g[0].adapter!==h.adapter){g=[];groups.push(g);}g.push(h);}
 const calls=groups.map((g,i)=>{const last=i===groups.length-1,recipient=last&&buy?addr(taker):BSC.smartRouter,amount=i===0?q.amount_raw:'0',min=last?q.min_out_raw:'0',tokens=[g[0].tokenIn,...g.map(h=>h.tokenOut)];return g[0].adapter==='PANCAKE_V3'?SMART_ROUTER.encodeFunctionData('exactInput',[[v3Path(tokens,g.map(h=>h.fee)),recipient,amount,min]]):SMART_ROUTER.encodeFunctionData('swapExactTokensForTokens',[amount,min,tokens,recipient]);});
 if(!buy)calls.push(SMART_ROUTER.encodeFunctionData('unwrapWETH9',[q.min_out_raw,taker]));calls.push(SMART_ROUTER.encodeFunctionData('refundETH'));return calls;
}
export function verifySmartTransaction(u,q,taker,deadline){
 check(Number(u.chainId??56)===56,'WRONG_CHAIN');check(addr(u.to)===BSC.smartRouter,'SMART_ROUTER_NOT_ALLOWED');check(BigInt(u.value??0)===(q.side==='BUY'?BigInt(q.amount_raw):0n),'SMART_VALUE_MISMATCH');check(Date.now()/1000<deadline,'TX_DEADLINE');
 const expected=SMART_ROUTER.encodeFunctionData('multicall',[deadline,smartCalls(q,taker,deadline)]);check(u.data.toLowerCase()===expected.toLowerCase(),'SMART_CALLDATA_MISMATCH');return true;
}
