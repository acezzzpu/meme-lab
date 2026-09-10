import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {TARGET,targetDefaults} from '../core/copy/schema.mjs';
import {applyFill,capitalCheck,assertCopyFence,calculateSize} from '../core/copy/execution-policy.mjs';
import {account,handleCopy} from '../core/copy/service.mjs';
import {BSC,ROUTER,encode,decode,wei,hex} from '../core/copy/common.mjs';
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
for(const mode of ['PAPER','SHADOW'])test(mode+' emergency wins at the atomic fill boundary',async t=>{
 const f=await fixture(t,{mode}),a=await action(f);let intercepted=false;const realBatch=f.store.batch.bind(f.store);
 f.store.batch=async statements=>{if(!intercepted&&statements[0]?.[0].includes("state='FILLING'")){intercepted=true;f.store.batch=realBatch;await f.store.stop();}return realBatch(statements);};
 assert.equal(await applyFill(f.store,a,{inputRaw:a.amount_raw,outputRaw:'1000000',feeRaw:'1'}),false);assert.ok(intercepted);
 assert.equal((await f.store.get('SELECT state FROM copy_actions WHERE id=?',a.id)).state,'CANCELLED');assert.equal((await f.store.get('SELECT COUNT(*) n FROM copy_ledger')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) n FROM copy_positions')).n,0);
});
test('already submitted LIVE fills are reconciled after emergency, exactly once',async t=>{
 const f=await fixture(t,{mode:'LIVE_APPROVAL'}),a=await action(f,{state:'SUBMITTED'});await f.store.stop();
 const fill={inputRaw:a.amount_raw,outputRaw:'1000000',feeRaw:'9'};assert.equal(await applyFill(f.store,a,fill),true);assert.equal(await applyFill(f.store,a,fill),false);
 assert.equal((await f.store.get('SELECT COUNT(*) n FROM copy_ledger')).n,1);assert.equal((await f.store.get('SELECT cost_raw FROM copy_positions')).cost_raw,(BigInt(a.amount_raw)+9n).toString());assert.equal((await f.store.setting('copy_config')).enabled,false);
});
test('pause cancels new AUTO buys and preserves armed AUTO exits and epoch',async t=>{
 const f=await fixture(t,{mode:'LIVE_AUTO'}),buy=await action(f,{id:'buy',state:'DETECTED'}),sell=await action(f,{id:'sell',side:'SELL',state:'APPROVED'});
 await handleCopy(f.store,'copy/pause','POST',{},OPTIONS);const c=await f.store.setting('copy_config');assert.equal(c.epoch,f.c.epoch);assert.equal(c.auto_armed,true);assert.equal(c.enabled,true);assert.equal(c.paused,true);
 assert.equal((await f.store.get('SELECT state FROM copy_actions WHERE id=?',buy.id)).state,'CANCELLED');assert.equal((await f.store.get('SELECT state FROM copy_actions WHERE id=?',sell.id)).state,'APPROVED');await assertCopyFence(f.store,sell,{signing:true});await assert.rejects(assertCopyFence(f.store,buy),/COPY_ENTRIES_PAUSED/);
});
test('realized loss and consecutive loss limits stop buys, while inventory-backed sells remain available',async t=>{
 const f=await fixture(t);await position(f);await f.store.run("INSERT INTO copy_ledger VALUES ('loss','loss','PAPER',?,?, '0',?)",(-wei('.02'.replace(/^\./,'0.'))).toString(),(-wei('0.02')).toString(),Date.now());
 const sell=await action(f,{id:'sell',side:'SELL'});await capitalCheck(f.store,sell,'1000000','1',f.c,f.tc);
 const buy=await action(f,{id:'buy'});await assert.rejects(capitalCheck(f.store,buy,buy.amount_raw,'1',f.c,f.tc),/MAX_DAILY_LOSS/);
 const streakConfig={...f.c,max_daily_loss_bnb:'1',max_consecutive_losses:1};await capitalCheck(f.store,sell,'1000000','1',streakConfig,f.tc);await assert.rejects(capitalCheck(f.store,buy,buy.amount_raw,'1',streakConfig,f.tc),/MAX_CONSECUTIVE_LOSSES/);
 await assert.rejects(capitalCheck(f.store,sell,'1000001','1',f.c,f.tc),/SELL_EXCEEDS_OWN_POSITION/);
});
test('integer ledger preserves exact cash, partial cost basis, fees and final profit',async t=>{
 const f=await fixture(t),buy=await action(f,{id:'buy',amount:'100'});assert.equal(await applyFill(f.store,buy,{inputRaw:'100',outputRaw:'7',feeRaw:'1'}),true);
 const partial=await action(f,{id:'partial',side:'SELL',amount:'3'});assert.equal(await applyFill(f.store,partial,{inputRaw:'3',outputRaw:'70',feeRaw:'1'}),true);
 let p=await f.store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'4');assert.equal(p.cost_raw,'58');assert.equal(p.realized_raw,'26');
 const full=await action(f,{id:'full',side:'SELL',amount:'4'});assert.equal(await applyFill(f.store,full,{inputRaw:'4',outputRaw:'85',feeRaw:'1'}),true);assert.equal(await applyFill(f.store,full,{inputRaw:'4',outputRaw:'85',feeRaw:'1'}),false);
 p=await f.store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'0');assert.equal(p.cost_raw,'0');assert.equal(p.realized_raw,'52');assert.ok(p.closed_at);
 const a=await account(f.store,'PAPER',f.c);assert.equal(a.cash,wei(f.c.paper_capital_bnb)+52n);assert.equal(a.realized,52n);assert.equal(a.positions.length,0);assert.equal((await f.store.get('SELECT COUNT(*) n FROM copy_ledger')).n,3);
});
test('mirror sells size from our inventory using the source fraction, not the source amount',async t=>{
 const f=await fixture(t);await position(f,{quantity:'1000000000000000000000000000007'});
 const size=await calculateSize(f.store,'PAPER',f.tc,TARGET,{side:'SELL',token:TOKEN,target_balance_before:'100000000000000000000',quantity_raw:'30000000000000000000'},f.c,null);
 assert.equal(size,300000000000000000000000000002n);
});
test('saving a validated AUTO target preserves the explicit arming',async t=>{
 const f=await fixture(t,{config:{live_enabled:true,auto_armed:true}}),now=Date.now();
 for(let i=0;i<20;i++)await f.store.run("INSERT INTO copy_events VALUES (?,?,?,1,'b',0,?,'CONFIRMED',?,'{}')",'e'+i,TARGET,'h'+i,i%2?'BUY':'SELL',now);
 for(let i=0;i<11;i++)await f.store.run("INSERT INTO copy_actions(id,event_id,target_id,mode,side,token,state,epoch,created_at,updated_at,data) VALUES (?,?,?,?,?,?,'FILLED',0,?,?,'{}')",'a'+i,'e'+i,TARGET,i===10?'SHADOW':'PAPER',i%2?'BUY':'SELL',TOKEN,now,now);
 await f.store.set('copy_live_proof',{target_id:TARGET,wallet:WALLET,buy:{hash:'buy'},sell:{hash:'sell'}});
 await handleCopy(f.store,'copy/target','POST',{address:TARGET,label:'Fixture AUTO',enabled:true,config:{...f.tc,mode:'LIVE_AUTO'}},OPTIONS);
 assert.equal((await f.store.setting('copy_config')).auto_armed,true);assert.equal(decode((await f.store.get('SELECT config FROM copy_targets WHERE id=?',TARGET)).config).mode,'LIVE_AUTO');
});
test('changing accounting modes cannot orphan existing target positions',async t=>{
 const f=await fixture(t);await position(f);await assert.rejects(handleCopy(f.store,'copy/target','POST',{address:TARGET,label:'Fixture',enabled:true,config:{...f.tc,mode:'SHADOW'}},OPTIONS),/CLOSE_POSITIONS_BEFORE_MODE_CHANGE/);
 assert.equal(decode((await f.store.get('SELECT config FROM copy_targets WHERE id=?',TARGET)).config).mode,'PAPER');assert.equal((await f.store.setting('copy_config')).epoch,f.c.epoch);
});
test('an unresolved LIVE receipt prevents changing wallet or allocation configuration',async t=>{
 const f=await fixture(t,{mode:'LIVE_APPROVAL'});await action(f,{state:'RECONCILIATION_REQUIRED'});
 const keys=['allocation_bnb','paper_capital_bnb','shadow_capital_bnb','max_trade_bnb','max_exposure_bnb','max_positions','max_daily_loss_bnb','max_consecutive_losses','max_gas_bnb','max_slippage_bps','max_price_impact_pct','max_quote_age_ms','deadline_seconds','confirmations','block_unknown_safety','execution_wallet'];
 const settings=Object.fromEntries(keys.map(k=>[k,f.c[k]]));settings.execution_wallet='0x3333333333333333333333333333333333333333';
 await assert.rejects(handleCopy(f.store,'copy/settings','POST',settings,OPTIONS),/PENDING_LIVE_TRANSACTION/);assert.equal((await f.store.setting('copy_config')).execution_wallet,WALLET);
});
async function approved(f){const quote={provider:'PANCAKE_V2',min_out_raw:'1000000'};const a=await action(f,{state:'AWAITING_APPROVAL',data:{quote,expires_at:Date.now()+60000}});await handleCopy(f.store,'copy/approve','POST',{id:a.id},OPTIONS);return f.store.get('SELECT * FROM copy_actions WHERE id=?',a.id);}
test('approval persists immutable size and output floor; new cash cannot enlarge the signed intent',async t=>{
 const f=await fixture(t,{mode:'LIVE_APPROVAL',target:{size_mode:'CAPITAL_PCT'}}),a=await approved(f),d=decode(a.data);assert.equal(d.approved_intent.amount_raw,a.amount_raw);assert.equal(d.approved_intent.min_out_raw,'1000000');assert.equal(d.approved_intent.wallet,WALLET);
 await f.store.run("INSERT INTO copy_ledger VALUES ('newcash','newcash','LIVE',?,'0','0',?)",wei('0.1').toString(),Date.now());const {e,calls}=engine(f);await e.processAction(a);
 assert.equal(calls.quote[0].amount,a.amount_raw);assert.equal(calls.sign,1);assert.equal(calls.broadcast,0);assert.equal((await f.store.get('SELECT error FROM copy_actions WHERE id=?',a.id)).error,'TEST_SIGNING_BOUNDARY');
});
test('a requote below the approved output floor is rejected before build or signing',async t=>{
 const f=await fixture(t,{mode:'LIVE_APPROVAL'}),a=await approved(f),{e,calls}=engine(f,{output:'999999'});await e.processAction(a);
 assert.equal((await f.store.get('SELECT state FROM copy_actions WHERE id=?',a.id)).state,'REJECTED');assert.equal((await f.store.get('SELECT error FROM copy_actions WHERE id=?',a.id)).error,'APPROVED_TERMS_CHANGED');assert.equal(calls.build,0);assert.equal(calls.sign,0);assert.equal(calls.broadcast,0);
});
test('unresolved nonce ownership blocks another LIVE transaction before requesting a new nonce',async t=>{
 const f=await fixture(t,{mode:'LIVE_APPROVAL'}),a=await approved(f);await action(f,{id:'uncertain',state:'RECONCILIATION_REQUIRED'});const {e,calls}=engine(f);await e.processAction(a);
 assert.equal((await f.store.get('SELECT error FROM copy_actions WHERE id=?',a.id)).error,'NONCE_BUSY');assert.equal(calls.nonce,0);assert.equal(calls.sign,0);assert.equal(calls.broadcast,0);
});
test('SHADOW records a simulated ledger without signing or broadcasting',async t=>{
 const f=await fixture(t,{mode:'SHADOW'}),a=await action(f,{state:'DETECTED'}),{e,calls}=engine(f);await e.processAction(a);const saved=await f.store.get('SELECT * FROM copy_actions WHERE id=?',a.id);
 assert.equal(saved.state,'FILLED');assert.equal(decode(saved.data).shadow.simulation.success,true);assert.equal(calls.sign,0);assert.equal(calls.broadcast,0);assert.equal(calls.nonce,0);assert.equal((await account(f.store,'LIVE',f.c)).cash,wei(f.c.allocation_bnb));
});
test('recovery cursor advances through blocks previously received out of order',async t=>{
 const f=await fixture(t),{e}=engine(f);e.targets=[];e.rpc.call=async(method,[tag])=>{assert.equal(method,'eth_getBlockByNumber');const n=Number(BigInt(tag));return {number:tag,hash:'block'+n,parentHash:'block'+(n-1),transactions:[]};};await f.store.set('copy_cursor',10);
 await e.block({height:14,provider:'fixture',received_at:Date.now(),method:'TEST'});assert.equal(await f.store.setting('copy_cursor'),10);
 for(const height of [11,12,13])await e.block({height,provider:'fixture',received_at:Date.now(),method:'RECOVERY',history:true});assert.equal(await f.store.setting('copy_cursor'),14);
});
test('a send timeout retains the same hash and nonce across restart and never retransmits automatically',async t=>{
 const f=await fixture(t,{mode:'LIVE_APPROVAL'}),a=await approved(f),{e,calls}=engine(f);const wallet=new Wallet('0x'+'17'.repeat(32));
 const unsigned={chainId:56,nonce:7,gasLimit:'21000',gasPrice:'1',to:WALLET,value:'0',data:'0x',type:0};const raw=await wallet.signTransaction(unsigned),hash=keccak256(raw),d=decode(a.data);d.quote={...d.quote,quoted_at:Date.now()};d.build={deadline:Math.floor(Date.now()/1000)+60};d.signed=await encrypt(raw,KEY);
 await f.store.run("UPDATE copy_actions SET state='SIGNED',hash=?,nonce=7,reserved_raw='2000000000000001',data=? WHERE id=?",hash,encode(d),a.id);await e.broadcast(await f.store.get('SELECT * FROM copy_actions WHERE id=?',a.id));
 let saved=await f.store.get('SELECT * FROM copy_actions WHERE id=?',a.id);assert.equal(saved.state,'SUBMISSION_UNKNOWN');assert.equal(saved.hash,hash);assert.equal(saved.nonce,7);assert.equal(calls.broadcast,1);
 e.startSigner=()=>{};e.refresh=async()=>{};await e.start();clearInterval(e.timer);await e.reconcile();await e.stop();saved=await f.store.get('SELECT * FROM copy_actions WHERE id=?',a.id);
 assert.equal(saved.state,'SUBMISSION_UNKNOWN');assert.equal(saved.hash,hash);assert.equal(saved.nonce,7);assert.equal(saved.reserved_raw,'2000000000000001');assert.equal(calls.broadcast,1);
});
test('historical and expired source events cannot authorize signing',async t=>{
 const f=await fixture(t,{mode:'LIVE_AUTO'});const history=await action(f,{id:'historic',event:{history:true}});await assert.rejects(assertCopyFence(f.store,history,{signing:true}),/HISTORICAL_EVENT_NOT_EXECUTABLE/);
 const stale=await action(f,{id:'stale',event:{target_at:Date.now()-130000}});await assert.rejects(assertCopyFence(f.store,stale,{signing:true}),/SIGNAL_EXPIRED/);
});
