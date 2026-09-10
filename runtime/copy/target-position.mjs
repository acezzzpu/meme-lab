import {encode} from '../../core/copy/common.mjs';

// This is the observed target ledger, separate from our virtual inventory.
// A watcher may join an existing position: unknown starting balances stay null.
export async function recordTargetPosition(store,targetId,event){
 if(!event.side||!event.token)return;
 const previous=await store.get('SELECT * FROM copy_target_positions WHERE target_id=? AND token=?',targetId,event.token);
 const sequence=event.block*100000+event.tx_index;
 if(previous&&previous.sequence>=sequence)return;
 const delta=BigInt(event.quantity_raw)*(event.side==='BUY'?1n:-1n);
 let balance=null;
 if(event.target_balance_before!==undefined)balance=BigInt(event.target_balance_before)+delta;
 else if(previous?.quantity_raw!==null&&previous?.quantity_raw!==undefined)balance=BigInt(previous.quantity_raw)+delta;
 if(balance!==null&&balance<0n)balance=null;
 const closed=event.full_exit?event.target_at:null;
 await store.run('INSERT INTO copy_target_positions VALUES (?,?,?,?,?,?,?) ON CONFLICT(target_id,token) DO UPDATE SET quantity_raw=excluded.quantity_raw,closed_at=excluded.closed_at,sequence=excluded.sequence,data=excluded.data WHERE excluded.sequence>copy_target_positions.sequence',targetId,event.token,balance===null?null:String(balance),closed,sequence,Date.now(),encode({last_hash:event.hash,last_kind:event.kind,balance_scope:'OBSERVED_TRANSFERS; reconcile unobserved activity before exact percentage'}));
}
