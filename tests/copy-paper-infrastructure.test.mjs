import test from 'node:test';
import assert from 'node:assert/strict';
import {BscRpc} from '../runtime/copy/rpc.mjs';
import {ZeroExRoute} from '../runtime/copy/routes.mjs';
import {WalletActivityProvider} from '../runtime/copy/activity-provider.mjs';
import {decodeEconomicTarget} from '../runtime/copy/economic-decoder.mjs';
import {nativeDeltaFromTrace} from '../runtime/copy/native-enrichment.mjs';
import {BSC,ERC20} from '../core/copy/common.mjs';
import {copyEnvironment} from '../runtime/copy/provider-config.mjs';
const wallet='0x0000000000000000000000000000000000000123',token='0x0000000000000000000000000000000000000456';
test('redundant HTTP read does not wait for blocked primary and never sends archive traffic on live lane',async()=>{
 const providers=['primary','secondary','archive'].map(role=>({id:role,role,enabled:true,http_url:'https://'+role+'.invalid'}));let aborted=false;const called=[];
 const rpc=new BscRpc(providers,{fetcher:async(url,{signal})=>{called.push(url);if(url.includes('primary'))return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);}));return new Response(JSON.stringify({result:'0x42'}));}});providers.forEach(p=>rpc.verified.add(p.id));
 assert.equal(await rpc.call('eth_blockNumber'),'0x42');assert.ok(aborted);assert.equal(called.length,2);assert.ok(!called.some(u=>u.includes('archive')));
});
test('0x PAPER price needs no funded taker, allowance or transaction; LIVE quote retains its entrypoint fence',async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);const urls=[];
 globalThis.fetch=async url=>{urls.push(new URL(url));return new Response(JSON.stringify({liquidityAvailable:true,buyAmount:'1000',minBuyAmount:'990',gas:'100000',gasPrice:'1000000000',tokenMetadata:{buyToken:{buyTaxBps:'100'}}}));};
 const route=new ZeroExRoute({call:()=>{throw Error('No RPC fallback expected');}},'unit-test-key');const q=await route.quote({paper:true,side:'BUY',token,amount:'100',slippageBps:100});
 assert.equal(urls[0].pathname,'/swap/allowance-holder/price');assert.equal(urls[0].searchParams.has('taker'),false);assert.equal(q.transaction,null);assert.equal(q.live_supported,false);assert.equal(q.token_metadata.buyToken.buyTaxBps,'100');
 await assert.rejects(route.quote({side:'BUY',token,amount:'100',slippageBps:100,taker:wallet}));assert.equal(urls[1].pathname,'/swap/allowance-holder/quote');
});
test('HTTP continues reporting health while WS heads are healthy; WS stays available on HTTP errors',async()=>{
 const reports=[],observations=[];let calls=0,fail=false;
 const p=new WalletActivityProvider({id:'primary',ws_url:'wss://unit.invalid'},{request:async(_p,m)=>{calls++;if(fail)throw Error('HTTP_TIMEOUT');return m==='eth_chainId'?'0x38':'0xa';}},[],o=>observations.push(o),(_id,status,data)=>reports.push({status,data}));
 p.stopped=false;p.socket={readyState:1};p.verified=true;p.subscriptions.set('heads','head');p.lastHeadAt=Date.now();await p.tick();assert.equal(calls,2);assert.equal(reports.at(-1).data.http.status,'CONNECTED');assert.equal(reports.at(-1).status,'CONNECTED');
 p.lastPoll=0;fail=true;await p.tick();assert.equal(reports.at(-1).status,'CONNECTED');assert.equal(reports.at(-1).data.http.status,'ERROR');
});
test('receipt-block end balance removes subsequent same-block transfers to recover exact pre-sell inventory',async()=>{
 const transfer=(from,to,amount,index)=>{const log=ERC20.encodeEventLog(ERC20.getEvent('Transfer'),[from,to,amount]);return {...log,address:token,transactionIndex:'0x'+index.toString(16)};};
 const ours=transfer(wallet,BSC.router,40n,2),after=transfer(wallet,BSC.router,10n,3),receipt={status:'0x1',blockNumber:'0xa',transactionIndex:'0x2',gasUsed:'0x1',effectiveGasPrice:'0x1',logs:[ours,{address:BSC.wbnb,topics:['0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65','0x'+BSC.router.slice(2).padStart(64,'0')],data:'0x64'}]};
 const rpc={contract:async(_to,_abi,method,_args,block)=>{assert.equal(method,'balanceOf');assert.equal(block,'0xa');return [50n];},call:async m=>{assert.equal(m,'eth_getLogs');return [ours,after];}};
 const d=await decodeEconomicTarget(rpc,{hash:'test',from:wallet,to:BSC.router,value:'0x0'},receipt,{timestamp:'0x1'},wallet);assert.equal(d.target_balance_before,'100');assert.equal(d.sold_fraction,.4);assert.equal(d.kind,'PARTIAL_SELL');
});
test('native audit excludes delegatecall duplication and reverted internal transfers',()=>{
 const trace={type:'CALL',from:wallet,to:BSC.router,value:'100',calls:[{type:'DELEGATECALL',from:wallet,to:token,value:'100',calls:[{type:'CALL',from:BSC.router,to:wallet,value:'1'}]},{type:'CALL',from:BSC.router,to:wallet,value:'20',error:'reverted'}]};
 assert.equal(nativeDeltaFromTrace(trace,wallet),-99n);
});
test('provider configuration validates pending mode without exposing credentials',()=>{
 const env={BSC_PRIMARY_HTTP:'https://bsc-rpc.publicnode.com',BSC_PRIMARY_WS:'wss://bsc-rpc.publicnode.com'};assert.equal(copyEnvironment(env).providers[0].pending,'STANDARD_FULL');assert.throws(()=>copyEnvironment({...env,BSC_PRIMARY_PENDING:'silently-wrong'}),/PENDING_INVALID/);
});
