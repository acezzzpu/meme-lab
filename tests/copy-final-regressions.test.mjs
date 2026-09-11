import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {TARGET,targetDefaults} from '../core/copy/schema.mjs';
import {applyFill,capitalCheck,assertCopyFence,calculateSize} from '../core/copy/execution-policy.mjs';
import {account,handleCopy} from '../core/copy/service.mjs';
import {BSC,ROUTER,ERC20,encode,decode,wei,hex} from '../core/copy/common.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {encrypt} from '../core/util.mjs';
import {Wallet,keccak256} from 'ethers';

// Isolated test fixtures only. No network requests, signer processes, or funded wallets.
const TOKEN='0x1111111111111111111111111111111111111111';
const WALLET='0x2222222222222222222222222222222222222222';
const KEY=Buffer.alloc(32,17).toString('base64');
const OPTIONS={runtime:'standalone',engineAvailable:true};
async function fixture(t,{mode='PAPER',target={},config={}}={}){
 const db=sqliteDriver(':memory:'),store=new Store(db,{encryptionKey:KEY});await store.init();t.after(()=>db.close());
 const c={...await store.setting('copy_config'),enabled:true,execution_wallet:WALLET,live_enabled:mode.startsWith('LIVE'),auto_armed:mode==='LIVE_AUTO',...config};
 await store.set('copy_config',c);await store.set('engine_desired','RUNNING');
 const tc={...targetDefaults,mode,min_liquidity_usd:0,max_signal_age_ms:120000,...target};
 await store.run('UPDATE copy_targets SET config=? WHERE id=?',encode(tc),TARGET);
 await store.set('copy_signer',{status:'CONNECTED',address:WALLET});return {store,db,c,tc};
}
async function action(f,{id='action',side='BUY',mode=f.tc.mode,state='PROCESSING',data={},amount='2000000000000000',epoch=f.c.epoch,event={}}={}){
 const now=Date.now(),eventId='event:'+id,e={hash:'0x'+id.padEnd(64,'0').slice(0,64),token:TOKEN,side,kind:side,decimals:6,symbol:'FIXTURE',quote_token:BSC.wbnb,quote_raw:'2000000000000000',quantity_raw:'1000000',price_quote:.002,target_at:now,history:false,...event};
 await f.store.run("INSERT INTO copy_events VALUES (?,?,?,1,'block',0,?,'CONFIRMED',?,?)",eventId,TARGET,e.hash,side,now,encode(e));
 await f.store.run('INSERT INTO copy_actions(id,event_id,target_id,mode,side,token,state,epoch,created_at,updated_at,amount_raw,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',id,eventId,TARGET,mode,side,TOKEN,state,epoch,now,now,amount,encode({event:e,...data}));
 return f.store.get('SELECT * FROM copy_actions WHERE id=?',id);
}
async function position(f,{mode=f.tc.mode.startsWith('LIVE')?'LIVE':f.tc.mode,quantity='1000000',cost='2000000000000000'}={}){
 const id=TARGET+':'+mode+':'+TOKEN;
 await f.store.run('INSERT INTO copy_positions VALUES (?,?,?,?,?,?,?,?,NULL,?)',id,TARGET,mode,TOKEN,quantity,cost,'0',Date.now(),encode({decimals:6,symbol:'FIXTURE'}));return id;
}
function engine(f,{output='1000000',onQuote=()=>{}}={}){
 const e=new CopyEngine(f.store,OPTIONS);const calls={sign:0,broadcast:0,build:0,nonce:0,quote:[]};
 e.routes={quote:async request=>{calls.quote.push(request);onQuote(request);return {provider:'PANCAKE_V2',side:request.side,token:TOKEN,amount_raw:String(request.amount),out_raw:output,min_out_raw:output,impact_pct:.01,slippage_bps:100,route:request.side==='BUY'?[BSC.wbnb,TOKEN]:[TOKEN,BSC.wbnb],liquidity_bnb:100,fee_raw:'1',quoted_at:Date.now(),quote_ms:1,recipient:WALLET,tax_adjusted:true};},build:async q=>{calls.build++;const deadline=Math.floor(Date.now()/1000)+20;return {tx:{from:WALLET,to:BSC.router,data:ROUTER.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',[q.min_out_raw,q.route,WALLET,deadline]),value:hex(q.amount_raw)},approval:null,deadline,provider:'PANCAKE_V2'};}};
 e.safety={inspect:async()=>({status:'PASSED',buy_tax:0,sell_tax:0,at:Date.now()})};
 e.rpc={metrics:[],call:async method=>{if(method==='eth_call')return '0x';if(method==='eth_estimateGas')return '0x5208';if(method==='eth_gasPrice')return '0x1';if(method==='eth_getBalance')return hex(wei('1'));if(method==='eth_getTransactionCount'){calls.nonce++;return '0x7';}if(method==='eth_getTransactionReceipt')return null;if(method==='eth_sendRawTransaction'){calls.broadcast++;throw Error('TEST_NETWORK_FORBIDDEN');}throw Error('UNEXPECTED_RPC_'+method);},contract:async()=>[0n]};
 e.sign=async()=>{calls.sign++;throw Error('TEST_SIGNING_BOUNDARY');};return {e,calls};
}

import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RouteEngine} from '../runtime/copy/routes.mjs';
import {routePaths} from '../runtime/copy/smart-routes.mjs';
const BRIDGE={address:'0x3333333333333333333333333333333333333333',token0:BSC.wbnb,token1:BSC.usdt,factory:BSC.factory,adapter:'PANCAKE_V2',fee:null};
const ASSET_POOL={address:'0x4444444444444444444444444444444444444444',token0:BSC.usdt,token1:TOKEN,factory:BSC.v3factory,adapter:'PANCAKE_V3',fee:500};

// All providers below are deterministic fixtures. No external requests or signatures.
test('false ERC20 approval rejects both zero-reset and exact grant before signer',async t=>{
 for(const reset of [true,false]){const f=await fixture(t,{mode:'LIVE_AUTO',target:{exit_mode:'FULL_MIRROR'}});await position(f);const a=await action(f,{side:'SELL',state:'DETECTED',amount:'1000000'}),{e,calls}=engine(f,{output:'2000000000000000'});
 e.routes.build=async()=>({tx:{},approval:{spender:BSC.smartRouter,amount_raw:'1000000',reset},deadline:Math.floor(Date.now()/1000)+30,provider:'PANCAKE_SMART'});const quote=e.routes.quote;e.routes.quote=async request=>({...await quote(request),provider:'PANCAKE_SMART'});
 const rpcCall=e.rpc.call;e.rpc.call=async method=>method==='eth_call'?ERC20.encodeFunctionResult('approve',[false]):rpcCall(method);await e.processAction(a);
 const result=await f.store.get('SELECT * FROM copy_actions WHERE id=?',a.id);assert.equal(result.state,'REJECTED');assert.equal(result.error,'TOKEN_APPROVAL_RETURNED_FALSE');assert.equal(calls.sign,0);assert.equal(calls.broadcast,0);assert.equal(calls.nonce,0);assert.equal((await f.store.get('SELECT COUNT(*) n FROM copy_ledger')).n,0);}
});

test('route hint cache retains authenticated bridge when a later source trade has only the asset pool',async()=>{
 const routes=new RouteEngine({});const seen=[];routes.providers=[{id:'PANCAKE_SMART',quote:async request=>{seen.push(request.hints);return {provider:'PANCAKE_SMART',impact_pct:0,out_raw:'100',fee_raw:'0',quote_ms:0};}}];
 const request={side:'SELL',token:TOKEN,amount:'1000',slippageBps:100,taker:WALLET};await routes.quote({...request,hints:[BRIDGE,ASSET_POOL]});await routes.quote({...request,hints:[ASSET_POOL]});await routes.quote(request);
 for(const hints of seen){assert.equal(hints.length,2);assert.equal(routePaths(hints,TOKEN,BSC.wbnb).length,1);assert.deepEqual(routePaths(hints,TOKEN,BSC.wbnb)[0].map(p=>p.pool),[ASSET_POOL.address,BRIDGE.address]);}
});

test('partial fill persists bridge pools and a fresh engine can close the remainder after SQLite reopen',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'copy-pool-restart-'));let db=sqliteDriver(join(folder,'test.sqlite'));let store=new Store(db,{encryptionKey:KEY});await store.init();t.after(async()=>{db.close();await rm(folder,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
 const c={...await store.setting('copy_config'),enabled:true,execution_wallet:WALLET};const tc={...targetDefaults,mode:'PAPER',exit_mode:'FULL_MIRROR',min_liquidity_usd:0,max_signal_age_ms:120000};await store.set('copy_config',c);await store.set('engine_desired','RUNNING');await store.run('UPDATE copy_targets SET config=? WHERE id=?',encode(tc),TARGET);let f={store,db,c,tc};
 const buy=await action(f,{id:'buy',event:{pools:[BRIDGE,ASSET_POOL]}});assert.equal(await applyFill(store,buy,{inputRaw:'2000000000000000',outputRaw:'1000000',feeRaw:'1'}),true);
 const partial=await action(f,{id:'partial',side:'SELL',amount:'300000',event:{pools:[ASSET_POOL],quantity_raw:'300000'}});assert.equal(await applyFill(store,partial,{inputRaw:'300000',outputRaw:'900000000000000',feeRaw:'1'}),true);let p=await store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'700000');assert.equal(decode(p.data).pools.length,2);
 db.close();db=sqliteDriver(join(folder,'test.sqlite'));store=new Store(db,{encryptionKey:KEY});await store.init();f={store,db,c:await store.setting('copy_config'),tc};p=await store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'700000');assert.equal(decode(p.data).pools.length,2);
 const sell=await action(f,{id:'remaining',side:'SELL',state:'DETECTED',event:{pools:[ASSET_POOL]}});const {e,calls}=engine(f,{output:'1400000000000000'});let observedHints;const routes=new RouteEngine({});assert.equal(routes.hints.size,0);routes.providers=[{id:'PANCAKE_SMART',quote:async request=>{observedHints=request.hints;const paths=routePaths(request.hints,TOKEN,BSC.wbnb);assert.equal(paths.length,1);return {provider:'PANCAKE_SMART',side:'SELL',token:TOKEN,amount_raw:request.amount,out_raw:'1400000000000000',min_out_raw:'1400000000000000',impact_pct:0,slippage_bps:100,fee_raw:'1',quoted_at:Date.now(),quote_ms:1,tax_adjusted:true};}}];e.routes=routes;await e.processAction(sell);
 assert.equal(observedHints.length,2);assert.equal((await store.get('SELECT state FROM copy_actions WHERE id=?',sell.id)).state,'FILLED');p=await store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'0');assert.ok(p.closed_at);assert.equal(decode(p.data).pools.length,2);assert.equal(calls.sign,0);assert.equal(calls.broadcast,0);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_ledger')).n,3);
});

test('successful receipt with unchanged reset allowance freezes execution and charges its gas once',async t=>{
 const f=await fixture(t,{mode:'LIVE_AUTO'});await position(f);const hash='0x'+'ab'.repeat(32);const a=await action(f,{side:'SELL',state:'SUBMITTED',amount:'1000000',data:{approval_tx:true,approval_amount_raw:'0',quote:{provider:'PANCAKE_SMART'}}});await f.store.run('UPDATE copy_actions SET hash=?,nonce=1,reserved_raw=? WHERE id=?',hash,'21000',a.id);
 const {e,calls}=engine(f);const block='0x10',receipt={transactionHash:hash,status:'0x1',blockNumber:block,blockHash:'canonical-block',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[]};let allowanceReads=0;
 e.rpc.call=async method=>{if(method==='eth_getTransactionReceipt')return receipt;if(method==='eth_blockNumber')return '0x12';if(method==='eth_getBlockByNumber')return {hash:receipt.blockHash,timestamp:'0x1'};throw Error('UNEXPECTED_RPC_'+method);};e.rpc.contract=async(token,abi,method,args,atBlock)=>{assert.equal(token,TOKEN);assert.equal(method,'allowance');assert.deepEqual(args,[WALLET,BSC.smartRouter]);assert.equal(atBlock,block);allowanceReads++;return [10n];};
 await e.reconcile();await e.reconcile();const saved=await f.store.get('SELECT * FROM copy_actions WHERE id=?',a.id);assert.equal(saved.state,'RECONCILIATION_REQUIRED');assert.equal(saved.error,'TOKEN_ALLOWANCE_NOT_APPLIED');assert.equal((await f.store.setting('copy_config')).live_enabled,false);assert.equal((await f.store.get('SELECT COUNT(*) n FROM copy_ledger')).n,1);assert.equal((await f.store.get('SELECT fee_raw FROM copy_ledger')).fee_raw,'21000');assert.equal((await f.store.get('SELECT quantity_raw FROM copy_positions')).quantity_raw,'1000000');assert.equal(allowanceReads,2);assert.equal(calls.sign,0);assert.equal(calls.broadcast,0);
});
