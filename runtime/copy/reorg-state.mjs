import {check,decode,encode,bucket,mergePools} from '../../core/copy/common.mjs';

function archive(id,table,key,row,status='REORGED_OUT'){
 return ['INSERT OR IGNORE INTO copy_reorg_archive VALUES (?,?,?,?,?,?,?)',[id,table,key,status,row.block_hash??null,encode(row),Date.now()]];
}

// Audit/reconstruction only. Order, integer cost allocation and fees are the
// same as the existing fill ledger. This never obtains a new quote or executes.
export function reconstructPosition(fills){
 let qty=0n,cost=0n,realized=0n,opened=null,closed=null,data={};
 for(const a of fills){
  const d=decode(a.data),f=d.fill;check(f,'REORG_FILL_EVIDENCE_MISSING');
  const input=BigInt(f.input_raw),output=BigInt(f.output_raw),fee=BigInt(f.fee_raw);check(input>0n&&output>0n&&fee>=0n,'REORG_INVALID_FILL');
  let pnl=0n,cash;
  if(a.side==='BUY'){qty+=output;cost+=input+fee;cash=-(input+fee);}
  else {check(qty>=input&&qty>0n,'REORG_POSITION_DEPENDENCY_UNPROVEN');const removed=cost*input/qty;qty-=input;cost-=removed;pnl=output-fee-removed;realized+=pnl;cash=output-fee;}
  if(a.delta_raw!==undefined)check(BigInt(a.delta_raw)===cash&&BigInt(a.pnl_raw)===pnl&&BigInt(a.fee_raw)===fee,'REORG_LEDGER_NOT_PROVEN');
  if(opened===null||closed!==null)opened=f.at;closed=qty===0n?f.at:null;
  data={...data,pools:mergePools(data.pools,d.event?.pools),symbol:d.event?.symbol??a.token,decimals:d.event?.decimals??data.decimals??null,last_price:f.price_bnb??null,marked_at:f.price_bnb?f.at:null,high_price:Math.max(data.high_price??0,f.price_bnb??0)};
 }
 return {quantity_raw:String(qty),cost_raw:String(cost),realized_raw:String(realized),opened_at:opened,closed_at:closed,data:encode(data)};
}

export async function planReorgRollback(store,incident,canonicalBlocks){
 const {id,common_ancestor:ancestor,replay_end:end}=incident,statements=[];
 const canonical=new Map(canonicalBlocks.map(b=>[Number(BigInt(b.number)),b.hash]));
 const blocks=await store.all('SELECT * FROM copy_blocks WHERE number>? AND number<=?',ancestor,end);
 const orphanBlocks=blocks.filter(b=>canonical.get(b.number)!==b.hash);
 const events=await store.all('SELECT * FROM copy_events WHERE block>? AND block<=?',ancestor,end);
 const orphanEvents=events.filter(e=>canonical.get(e.block)!==e.block_hash),orphanIds=new Set(orphanEvents.map(e=>e.id));
 const actions=await store.all('SELECT * FROM copy_actions WHERE event_id IN (SELECT id FROM copy_events WHERE block>? AND block<=?)',ancestor,end);
 const orphanActions=actions.filter(a=>orphanIds.has(a.event_id));
 check(!orphanActions.some(a=>a.mode.startsWith('LIVE')&&['FILLED','SUBMITTED','SUBMISSION_UNKNOWN','SUBMITTING','SIGNED'].includes(a.state)),'REORG_LIVE_STATE_REQUIRES_REVIEW');
 const positionKeys=new Map(orphanActions.filter(a=>a.token).map(a=>[a.target_id+':'+bucket(a.mode)+':'+a.token,{target:a.target_id,mode:bucket(a.mode),token:a.token}]));
 for(const [positionId,key] of positionKeys){
  const current=await store.get('SELECT * FROM copy_positions WHERE id=?',positionId);
  const fills=await store.all('SELECT a.*,l.delta_raw,l.pnl_raw,l.fee_raw FROM copy_actions a JOIN copy_ledger l ON l.action_id=a.id WHERE a.target_id=? AND a.token=? AND l.mode=? ORDER BY l.at,l.rowid',key.target,key.token,key.mode);
  if(!current){check(fills.length===0,'REORG_POSITION_MISSING');continue;}
  const original=reconstructPosition(fills);
  check(['quantity_raw','cost_raw','realized_raw'].every(k=>original[k]===current[k]),'REORG_POSITION_NOT_PROVEN');
  let changed=false;
  for(const f of fills){if(orphanIds.has(f.event_id))changed=true;else if(changed)throw Error('REORG_POSITION_DEPENDENCY_UNPROVEN');}
  const remaining=fills.filter(a=>!orphanIds.has(a.event_id)),rebuilt=reconstructPosition(remaining);
  statements.push(archive(id,'copy_positions',positionId,current,'BEFORE_RECONCILIATION'));
  if(!remaining.length)statements.push(['DELETE FROM copy_positions WHERE id=?',[positionId]]);
  else statements.push(['UPDATE copy_positions SET quantity_raw=?,cost_raw=?,realized_raw=?,opened_at=?,closed_at=?,data=? WHERE id=?',[rebuilt.quantity_raw,rebuilt.cost_raw,rebuilt.realized_raw,rebuilt.opened_at,rebuilt.closed_at,rebuilt.data,positionId]]);
 }
 for(const a of orphanActions){
  statements.push(archive(id,'copy_actions',a.id,a));
  const ledger=await store.get('SELECT * FROM copy_ledger WHERE action_id=?',a.id);
  if(ledger){statements.push(archive(id,'copy_ledger',ledger.id,ledger));statements.push(['DELETE FROM copy_ledger WHERE action_id=?',[a.id]]);}
  statements.push(["UPDATE copy_actions SET state='REORGED_OUT',reserved_raw='0',error='SOURCE_BLOCK_REORGED_OUT',updated_at=? WHERE id=?",[Date.now(),a.id]]);
 }
 for(const ev of orphanEvents){
  statements.push(archive(id,'copy_events',ev.id+':'+ev.block_hash,ev));
  statements.push(["UPDATE copy_events SET status='REORGED_OUT' WHERE id=?",[ev.id]]);
  for(const [table,query,args,key] of [
   ['copy_source_transactions','SELECT * FROM copy_source_transactions WHERE chain_id=56 AND hash=?',[ev.hash],ev.hash],
   ['copy_intents','SELECT * FROM copy_intents WHERE chain_id=56 AND hash=? AND target_id=?',[ev.hash,ev.target_id],ev.target_id+':'+ev.hash],
   ['copy_latency_profiles','SELECT * FROM copy_latency_profiles WHERE event_id=?',[ev.id],ev.id]
  ]){
   const row=await store.get(query,...args);if(!row)continue;statements.push(archive(id,table,key,row));
   if(table==='copy_latency_profiles'){
    const data=decode(row.data);data.canonical_status='REORGED_OUT';data.reorg_id=id;
    if(data.paper)data.paper={...data.paper,status:'REORGED_OUT'};
    if(data.shadow)data.shadow={...data.shadow,status:'REORGED_OUT',simulation:{...data.shadow.simulation,status:'REORGED_OUT'}};
    statements.push(['UPDATE copy_latency_profiles SET data=?,updated_at=? WHERE event_id=?',[encode(data),Date.now(),ev.id]]);
   }else statements.push([`UPDATE ${table} SET status='REORGED_OUT' WHERE chain_id=56 AND hash=?`+(table==='copy_intents'?' AND target_id=?':''),args]);
  }
 }
 // The old implementation marked every >=N event ORPHANED before asking any
 // provider. Restore an inclusion only when the canonical hash proves it.
 for(const ev of events.filter(ev=>ev.status==='ORPHANED'&&canonical.get(ev.block)===ev.block_hash)){
  statements.push(archive(id,'copy_events',ev.id+':legacy-status',ev,'LEGACY_STATUS_REPAIRED'));
  statements.push(['UPDATE copy_events SET status=? WHERE id=?',[decode(ev.data).raw?.receipt?.status==='0x1'?'CONFIRMED':'FAILED',ev.id]]);
 }
 const targets=new Map(orphanEvents.map(e=>{const d=decode(e.data);return [e.target_id+':'+d.token,{target:e.target_id,token:d.token}];}).filter(([,k])=>k.token));
 for(const [key,{target,token}] of targets){
  const current=await store.get('SELECT * FROM copy_target_positions WHERE target_id=? AND token=?',target,token);
  if(current)statements.push(archive(id,'copy_target_positions',key,current,'BEFORE_RECONCILIATION'));
  const rows=(await store.all("SELECT * FROM copy_events WHERE target_id=? AND json_extract(data,'$.token')=? AND status='CONFIRMED' ORDER BY block,tx_index",target,token)).filter(e=>!orphanIds.has(e.id));
  let position=null;
  for(const row of rows){const d=decode(row.data);if(!d.side)continue;const delta=BigInt(d.quantity_raw)*(d.side==='BUY'?1n:-1n);let balance=d.target_balance_before!==undefined?BigInt(d.target_balance_before)+delta:position?.quantity_raw!=null?BigInt(position.quantity_raw)+delta:null;if(balance!==null&&balance<0n)balance=null;
   position={quantity_raw:balance===null?null:String(balance),closed_at:d.full_exit?d.target_at:null,sequence:row.block*100000+row.tx_index,data:encode({last_hash:row.hash,last_kind:d.kind,balance_scope:'OBSERVED_TRANSFERS; reconcile unobserved activity before exact percentage'})};
  }
  statements.push(['DELETE FROM copy_target_positions WHERE target_id=? AND token=?',[target,token]]);
  if(position)statements.push(['INSERT INTO copy_target_positions VALUES (?,?,?,?,?,?,?)',[target,token,position.quantity_raw,position.closed_at,position.sequence,Date.now(),position.data]]);
 }
 return {statements,orphanBlocks,audit:{affected_target_transactions:orphanEvents.map(e=>({hash:e.hash,id:e.id,block:e.block,block_hash:e.block_hash,kind:e.kind})),affected_paper_actions:orphanActions.filter(a=>a.mode.startsWith('PAPER')).map(a=>({id:a.id,side:a.side,previous_state:a.state})),affected_shadow_actions:orphanActions.filter(a=>a.mode==='SHADOW').map(a=>({id:a.id,side:a.side,previous_state:a.state})),affected_shadow_comparisons:(await store.all('SELECT event_id FROM copy_latency_profiles WHERE json_type(data,\'$.shadow\') IS NOT NULL')).filter(p=>orphanIds.has(p.event_id)).map(p=>p.event_id),positions_reconciled:[...positionKeys.keys()]}};
}

// Same tx hash may be re-included in a canonical replacement block. The old
// inclusion stays in the immutable archive while stable active keys are reused.
export async function prepareCanonicalReinclusion(store,eventId,blockHash){
 const row=await store.get('SELECT * FROM copy_events WHERE id=?',eventId);
 if(row?.status!=='REORGED_OUT')return row;
 check(blockHash&&blockHash!==row.block_hash,'REORGED_INCLUSION_CANNOT_BE_REPLAYED');
 check(await store.get("SELECT row_key FROM copy_reorg_archive WHERE table_name='copy_events' AND row_key=?",row.id+':'+row.block_hash),'REORG_ARCHIVE_MISSING');
 await store.batch([
  ["DELETE FROM copy_actions WHERE event_id=? AND state='REORGED_OUT'",[eventId]],
  ['DELETE FROM copy_latency_profiles WHERE event_id=?',[eventId]],
  ["DELETE FROM copy_events WHERE id=? AND status='REORGED_OUT'",[eventId]]
 ]);return null;
}
