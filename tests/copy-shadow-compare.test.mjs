import test from 'node:test';
import assert from 'node:assert/strict';
import {buildShadowUnsigned,ShadowReadBudget,shadowRead,compareShadow,SHADOW_WALLET} from '../runtime/copy/shadow-compare.mjs';
import {BSC,ROUTER,decode,encode} from '../core/copy/common.mjs';
import {FLAP} from '../runtime/copy/flap.mjs';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
const token='0x'+'67'.repeat(20),config={max_slippage_bps:100,deadline_seconds:20,max_quote_age_ms:1500};
const quote=(side='BUY')=>({provider:'FLAP_PORTAL',side,token,amount_raw:'2000000000000000',out_raw:'1000000',min_out_raw:'990000',slippage_bps:100,quoted_at:Date.now(),gas_price:'100000000',portal_state:{status:1}});
test('unsigned Flap BUY/SELL preserve exact PAPER terms and declare missing onchain deadline',()=>{
 for(const side of ['BUY','SELL']){const q=quote(side),b=buildShadowUnsigned(q,config);const tx=FLAP.parseTransaction({data:b.unsigned_transaction.data,value:b.unsigned_transaction.value});assert.equal(tx.args.params.inputAmount,BigInt(q.amount_raw));assert.equal(tx.args.params.minOutputAmount,990000n);assert.equal(b.unsigned_transaction.from,SHADOW_WALLET);assert.equal(b.deadline,null);assert.equal(b.onchain_deadline_supported,false);assert.equal(!!b.approval,side==='SELL');assert.ok(!('signature' in b.unsigned_transaction));}
});
test('Pancake unsigned swaps bind path, size, recipient and deadline',()=>{
 const q={...quote('SELL'),provider:'PANCAKE_V2',route:[token,BSC.wbnb]},b=buildShadowUnsigned(q,config,2000000),parsed=ROUTER.parseTransaction({data:b.unsigned_transaction.data});assert.equal(parsed.args[0],BigInt(q.amount_raw));assert.equal(parsed.args[1],990000n);assert.equal(parsed.args[4],2020n);assert.equal(b.deadline,2020);assert.throws(()=>buildShadowUnsigned({...q,route:[BSC.wbnb,token]},config),/MISMATCH/);
});
test('mixed Uniswap/Pancake indicative route is never represented as an atomic unsigned swap',()=>{
 assert.throws(()=>buildShadowUnsigned({...quote(),provider:'PAPER_DEX_PATH',hops:[{adapter:'PANCAKE_V2'},{adapter:'UNISWAP_V3'}]},config),/NO_ATOMIC_BUILDER/);
});
test('failed SHADOW build persists its real duration and does not attempt network requests',async()=>{
 const db=sqliteDriver(':memory:'),store=new Store(db);await store.init();
 const result=await compareShadow({store,eventClocks:new Map()},{id:'a',side:'BUY',event_id:'ev'},{hash:'h',token,side:'BUY'},{...quote(),provider:'PAPER_DEX_PATH',hops:[{adapter:'PANCAKE_V2'},{adapter:'UNISWAP_V3'}]},config);
 assert.equal(result.status,'BUILD_FAILED');assert.equal(result.simulation.status,'NOT_ATTEMPTED');
 const p=decode((await store.get('SELECT data FROM copy_latency_profiles')).data);assert.ok(p.stages.SHADOW_BUILD>=0);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_ledger')).n,0);db.close();
});
test('SHADOW hard read budget, read-only method allowlist and independent ledger',async()=>{
 let now=100000;const budget=new ShadowReadBudget({limit:2,now:()=>now});budget.take();budget.take();assert.throws(()=>budget.take(),/BUDGET/);now+=60001;budget.take();
 await assert.rejects(shadowRead({},'eth_sendRawTransaction',[]),/READ_ONLY/);
 const db=sqliteDriver(':memory:'),store=new Store(db);await store.init();const calls=[];
 const e={store,boot:1,eventClocks:new Map(),rpc:{providers:[{id:'p',enabled:true}],verified:new Set(['p']),cooldown:new Map(),unsupported:new Map(),withContext:(_c,fn)=>fn(),request:async(_p,method)=>{calls.push(method);if(method==='eth_estimateGas')throw Error('allowance unavailable');return [{calls:[{status:'0x1',returnData:'0x00'},{status:'0x1',returnData:'0x01'},{status:'0x0',returnData:'0x',error:{message:'insufficient token balance'}},{status:'0x1',returnData:'0x00'}]}];}}};
 const result=await compareShadow(e,{id:'a',side:'SELL',event_id:'ev'},{hash:'h',token,side:'SELL'},quote('SELL'),config);assert.equal(result.unsigned_tx_built,true);assert.equal(result.simulation.status,'FAIL');assert.equal(result.broadcast,false);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_ledger')).n,0);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_positions')).n,0);assert.deepEqual(calls.sort(),['eth_estimateGas','eth_simulateV1']);assert.equal(decode((await store.get('SELECT data FROM copy_latency_profiles')).data).shadow.simulation.initial_token_balance_raw,'0');db.close();
});
test('successful SHADOW BUY requires actual simulated token credit above the quoted minimum',async()=>{
 const db=sqliteDriver(':memory:'),store=new Store(db);await store.init();let output='0xf4240';
 const e={store,boot:1,eventClocks:new Map(),rpc:{providers:[{id:'p',enabled:true}],verified:new Set(['p']),cooldown:new Map(),unsupported:new Map(),withContext:(_c,fn)=>fn(),request:async(_p,m)=>m==='eth_estimateGas'?'0x30000':[{calls:[{status:'0x1',returnData:'0x0'},{status:'0x1',returnData:'0x',gasUsed:'0x25000'},{status:'0x1',returnData:output}]}]}};
 let result=await compareShadow(e,{id:'a',side:'BUY',event_id:'ev'},{hash:'h',token,side:'BUY'},quote(),config);assert.equal(result.simulation.status,'PASS');assert.equal(result.simulated_output_raw,'1000000');assert.equal(result.estimated_gas,'196608');
 output='0x0';result=await compareShadow(e,{id:'a',side:'BUY',event_id:'ev'},{hash:'h',token,side:'BUY'},quote(),config);assert.equal(result.simulation.status,'FAIL');assert.match(result.simulation.output_validation_error,/BELOW_MINIMUM/);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_ledger')).n,0);db.close();
});
