import {writeEvidence} from './v4-evidence-io.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {Interface} from 'ethers';
import {FourMemeRoute} from '../runtime/copy/four-meme.mjs';
import {UniswapV4Route} from '../runtime/copy/uniswap-v4.mjs';
const records=JSON.parse(readFileSync(process.env.V4_BUY_EVIDENCE)).results;
const wallet='0x00000000000000000000000000000000b0bc0f56',erc=new Interface(['function balanceOf(address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
let id=0;const rpc={call:async(method,params=[])=>{const j=await(await fetch(process.env.V4_FIXTURE_RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(10000)})).json();if(j.error)throw Error(JSON.stringify(j.error));return j.result;},contract:async(to,abi,method,args=[],block='latest')=>abi.decodeFunctionResult(method,await rpc.call('eth_call',[{to,data:abi.encodeFunctionData(method,args)},block]))};
const results=[];for(const r of records.filter(r=>r.id!=='R3'))for(const pct of [50,100]){const row={id:r.id,exit_pct:pct,signed:false,broadcast:false,status:'FAIL'};try{
 const route=r.id==='R5'?new UniswapV4Route(rpc):new FourMemeRoute(rpc),q=r.quote,amount=BigInt(r.credit_raw)*BigInt(pct)/100n;
 const sell=await route.quote({side:'SELL',token:q.token,amount,taker:wallet,slippageBps:300,blockTag:q.quote_block,hints:q.pools});row.quote=sell;
 const b=await route.build(sell,wallet,{max_quote_age_ms:10000,deadline_seconds:30});const buy=await route.build({...q,quoted_at:Date.now()},wallet,{max_quote_age_ms:10000,deadline_seconds:30});
 const approvals=b.approvals??(b.approval?[{from:wallet,to:q.token,data:erc.encodeFunctionData('approve',[b.approval.spender,amount]),value:'0x0'}]:[]);
 const balance={from:wallet,to:q.token,data:erc.encodeFunctionData('balanceOf',[wallet])};const calls=[buy.tx,balance,...approvals,b.tx,balance].map(c=>({...c,gas:'0x4c4b40'}));
 const sim=await rpc.call('eth_simulateV1',[{blockStateCalls:[{blockOverrides:{time:'0x'+Math.floor(Date.now()/1000).toString(16)},stateOverrides:{[wallet]:{balance:'0xde0b6b3a7640000'}},calls}],validation:false,traceTransfers:true},q.quote_block]);row.simulation=sim;const seq=sim[0].calls;
 if(!seq.every(s=>s.status==='0x1'))throw Error(seq.find(s=>s.status!=='0x1').error?.message??'REVERT');
 const before=BigInt(seq[1].returnData),after=BigInt(seq.at(-1).returnData);if(before-after!==BigInt(sell.amount_raw))throw Error('SELL_INVENTORY_MISMATCH');row.requested_raw=String(amount);row.sold_raw=sell.amount_raw;row.remaining_raw=String(after);row.status='PASS';
 }catch(e){row.error=e.message;}console.log(row.id,pct,row.status,row.error??row.remaining_raw);results.push(row);}
writeEvidence('sell-replay',{at:Date.now(),results});if(results.some(r=>r.status!=='PASS'))process.exitCode=1;

