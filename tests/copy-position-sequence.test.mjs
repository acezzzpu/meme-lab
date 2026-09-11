import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {TARGET} from '../core/copy/schema.mjs';
import {decode,encode} from '../core/copy/common.mjs';
test('PAPER multiple buys, 40 percent sale, 99 percent sale, full exit and reentry conserve exact inventory and PnL',async t=>{
 const db=sqliteDriver(':memory:'),store=new Store(db,{encryptionKey:Buffer.alloc(32,2).toString('base64')});await store.init();t.after(()=>db.close());await store.set('engine_desired','RUNNING');const c={...await store.setting('copy_config'),enabled:true};await store.set('copy_config',c);
 const e=new CopyEngine(store),token='0x'+'67'.repeat(20);let quotedInput;
 e.routes={quote:async r=>{quotedInput=BigInt(r.amount);return {provider:'SYNTHETIC_ACCOUNTING_TEST_ONLY',amount_raw:r.amount,out_raw:r.side==='BUY'?'1000000':String(quotedInput*10000000000n),min_out_raw:r.side==='BUY'?'1000000':String(quotedInput*10000000000n),fee_raw:'100',slippage_bps:100,quoted_at:Date.now(),tax_adjusted:true};}};
 async function trade(n,side,amount,before){const now=Date.now(),event={hash:'synthetic-'+n,kind:side,side,token,decimals:18,quantity_raw:String(amount),target_balance_before:before===null?undefined:String(before),target_at:now,history:false};const id='sequence-'+n;await store.run("INSERT INTO copy_events VALUES (?,?,?,1,'test',? ,?,'CONFIRMED',?,?)",id,TARGET,event.hash,n,side,now,encode(event));await e.createAction(id,TARGET,event,'PAPER',c.epoch);const a=await store.get('SELECT * FROM copy_actions WHERE event_id=?',id);await e.processAction(a);const saved=await store.get('SELECT * FROM copy_actions WHERE id=?',a.id);assert.equal(saved.state,'FILLED',saved.error);return decode(saved.data).fill;}
 await trade(1,'BUY',1,null);await trade(2,'BUY',999999999,null);assert.equal(quotedInput,2000000000000000n,'Our size stays fixed regardless of target amount');let p=await store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'2000000');
 await trade(3,'SELL',40,100);assert.equal(quotedInput,800000n);p=await store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'1200000');
 await trade(4,'SELL',99,100);assert.equal(quotedInput,1188000n);p=await store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'12000');assert.equal(p.closed_at,null,'99 percent is never silently rounded to a full exit');
 await trade(5,'SELL',1,1);assert.equal(quotedInput,12000n);p=await store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'0');assert.equal(p.cost_raw,'0');assert.ok(p.closed_at);
 const ledger=await store.all('SELECT pnl_raw FROM copy_ledger');assert.equal(BigInt(p.realized_raw),ledger.reduce((sum,r)=>sum+BigInt(r.pnl_raw),0n));
 await trade(6,'BUY',5,null);p=await store.get('SELECT * FROM copy_positions');assert.equal(p.quantity_raw,'1000000');assert.equal(p.closed_at,null);assert.equal((await store.get('SELECT COUNT(*) n FROM copy_ledger')).n,6);
});
