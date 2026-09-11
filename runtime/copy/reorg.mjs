import {randomUUID} from 'node:crypto';
import {check,decode,encode,hex} from '../../core/copy/common.mjs';
import {planReorgRollback} from './reorg-state.mjs';

const KEY='copy_reconciliation_required';
const setting=(key,value)=>['INSERT INTO settings VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[key,encode(value),Date.now()]];
const header=b=>b?{number:Number(BigInt(b.number)),hash:b.hash,parent_hash:b.parentHash,timestamp:Number(BigInt(b.timestamp??0))*1000}:null;
const archive=(id,table,key,row,status='REORGED_OUT')=>['INSERT OR IGNORE INTO copy_reorg_archive VALUES (?,?,?,?,?,?,?)',[id,table,key,status,row.block_hash??row.hash??null,encode(row),Date.now()]];

export async function activeQuarantines(store){return store.all('SELECT * FROM copy_provider_quarantine WHERE until_at>?',Date.now());}

// Called inside the serialized block commit. Never waits for other workers here.
// The independent recovery loop waits for their existing fences to drain.
export async function beginReorg(e,height,reason,evidence={}){
 if(e.reorgActive||await e.store.setting(KEY))return;
 e.reorgActive=true;
 const config=await e.store.setting('copy_config'),now=Date.now(),id=randomUUID();
 const old=await e.store.get('SELECT * FROM copy_blocks WHERE number=?',height);
 const pending=await e.store.all("SELECT * FROM copy_actions WHERE state IN ('DETECTED','PROCESSING','QUOTED','APPROVED','SHADOW_PREPARED') AND mode NOT LIKE 'LIVE%'");
 const incident={id,height,reason,at:now,reorg_detected_at:now,old_block_hash:old?.hash??null,trigger:evidence,previous_config:{enabled:config.enabled,paused:config.paused},owned_epoch:config.epoch+1,pending_actions:pending,reconciliation_started_at:now,phase:'VERIFYING'};
 try{await e.store.batch([
  setting('copy_config',{...config,enabled:false,paused:true,epoch:incident.owned_epoch,auto_armed:false,live_enabled:false}),
  setting(KEY,incident),
  ['INSERT INTO copy_reorg_incidents VALUES (?,?,?,?,?)',[id,height,'RECONCILING',now,encode(incident)]]
 ]);}catch(error){e.reorgActive=false;throw error;}
 await e.report('REORG','Block consistency check: reconciling with independent BNB providers',{height,reason,incident_id:id});
}

async function adoptLegacy(e,flag){
 const config=await e.store.setting('copy_config'),now=Date.now(),old=await e.store.get('SELECT * FROM copy_blocks WHERE number=?',flag.height);
 const incident={...flag,id:randomUUID(),reorg_detected_at:flag.at,old_block_hash:old?.hash??null,legacy:true,previous_config:{enabled:!config.enabled&&config.paused,paused:false},owned_epoch:config.epoch,pending_actions:[],reconciliation_started_at:now,phase:'VERIFYING'};
 await e.store.batch([setting(KEY,incident),['INSERT INTO copy_reorg_incidents VALUES (?,?,?,?,?)',[incident.id,flag.height,'RECONCILING',now,encode(incident)]]]);
 return incident;
}

// No extra RPC traffic during normal capture. Quorum work is bounded to an
// incident and explicitly attributed to each configured provider.
export async function canonicalEvidence(rpc,height,{maxDepth=12}={}){
 const now=Date.now(),hosts=new Set();
 const providers=rpc.providers.filter(p=>{if(!p.enabled||['archive','benchmark'].includes(p.role)||now<(rpc.cooldown?.get(p.id)??0))return false;const host=p.http_url?new URL(p.http_url).hostname:p.id;if(hosts.has(host))return false;hosts.add(host);return true;});
 check(providers.length>=2,'REORG_NO_PROVIDER_QUORUM');
 const evidence=await Promise.all(providers.map(async p=>{
  const entry={provider:p.id,at:Date.now(),blocks:{},errors:[]};
  try{
   entry.latest=header(await rpc.request(p,'eth_getBlockByNumber',['latest',false],8000));
   check(entry.latest&&entry.latest.number>=height,'PROVIDER_BEHIND_REORG_BLOCK');
   check(Date.now()-entry.latest.timestamp<30000,'PROVIDER_HEAD_STALE');
   for(const n of [height-1,height,height+1]){
    if(n>entry.latest.number)continue;
    entry.blocks[n]=header(await rpc.request(p,'eth_getBlockByNumber',[hex(n),false],8000));
    check(entry.blocks[n]?.number===n,'REORG_BLOCK_NOT_AVAILABLE');
   }
   const a=entry.blocks[height-1],b=entry.blocks[height],c=entry.blocks[height+1];
   check(b.parent_hash===a.hash&&(!c||c.parent_hash===b.hash),'PROVIDER_INCOHERENT_CHAIN');
   entry.healthy=true;
  }catch(error){entry.errors.push(error.message);entry.healthy=false;}
  return entry;
 }));
 const get=async n=>{
  check(n>=height-maxDepth&&n<=height+maxDepth,'REORG_DEPTH_LIMIT');
  await Promise.all(evidence.filter(p=>p.healthy&&!p.blocks[n]&&p.latest.number>=n).map(async entry=>{
   try{const p=providers.find(p=>p.id===entry.provider);entry.blocks[n]=header(await rpc.request(p,'eth_getBlockByNumber',[hex(n),false],8000));}
   catch(error){entry.errors.push(error.message);}
  }));
  const votes=new Map();let total=0;
  for(const entry of evidence){const b=entry.blocks[n];if(!entry.healthy||!b||b.number!==n)continue;total++;const k=b.hash+':'+b.parent_hash;const group=votes.get(k)??{block:b,providers:[]};group.providers.push(entry.provider);votes.set(k,group);}
  const ordered=[...votes.values()].sort((a,b)=>b.providers.length-a.providers.length),winner=ordered[0];
  check(winner&&winner.providers.length>=2&&winner.providers.length>total/2,'REORG_NO_PROVIDER_QUORUM');
  return winner;
 };
 return {evidence,get,providers};
}

async function saveIncident(e,incident,status){
 await e.store.batch([setting(KEY,incident),['UPDATE copy_reorg_incidents SET status=?,data=? WHERE id=?',[status,encode(incident),incident.id]]]);
}

export async function recoverReorg(e){
 if(e.closed||e.reorgRecoveryBusy)return false;
 let incident=await e.store.setting(KEY);if(!incident)return false;
 if(incident.retry_at>Date.now()||incident.final_status==='MANUAL_REVIEW'&&incident.manual_reason!=='REORG_NO_PROVIDER_QUORUM')return false;
 e.reorgActive=true;e.reorgRecoveryBusy=true;
 try{
  if(!incident.id)incident=await adoptLegacy(e,incident);
  // In-flight decodes/actions/marks/shadow checks may still be finishing. Do not
  // rebuild a position while one of them can write an old result afterwards.
  if(e.busy||e.markBusy||e.captureBusy||e.shadowTasks?.size||e.routeResearchTask||e.targetWorkCount||e.blockReads.size)return false;
  await e.blockCommit;await e.headCommit;
  const config=await e.store.setting('copy_config');
  check(!config.live_enabled,'REORG_LIVE_MUST_REMAIN_DISABLED');
  const policy=await e.store.setting('copy_reorg_policy')??{},maxDepth=policy.max_depth??12;
  check(Number.isInteger(maxDepth)&&maxDepth>=1&&maxDepth<=64,'REORG_INVALID_DEPTH_LIMIT');
  if(incident.phase==='VERIFYING'){
   const run=()=>canonicalEvidence(e.rpc,incident.height,{maxDepth});
   const quorum=await (e.rpc.withContext?e.rpc.withContext({pipeline:'REORG_RECONCILIATION',priority:2},run):run());
   incident.provider_evidence=quorum.evidence;
   const canonical=await quorum.get(incident.height),saved=await e.store.get('SELECT * FROM copy_blocks WHERE number=?',incident.height);
   incident.new_block_hash=canonical.block.hash;
   let ancestor=incident.height;
   while(true){const local=await e.store.get('SELECT * FROM copy_blocks WHERE number=?',ancestor);const current=await quorum.get(ancestor);if(local?.hash===current.block.hash)break;ancestor--;check(incident.height-ancestor<=maxDepth,'REORG_DEPTH_LIMIT');check(local||ancestor>=incident.height-1,'REORG_COMMON_ANCESTOR_NOT_PROVEN');}
   incident.classification=saved&&saved.hash!==canonical.block.hash?'REAL_CHAIN_REORG':'PROVIDER_DISAGREEMENT';
   // An old, contradictory notification cannot turn an unchanged canonical
   // block into an arbitrarily deep reorg merely because the watcher advanced.
   const storedTip=ancestor===incident.height?ancestor:(await e.store.get('SELECT MAX(number) n FROM copy_blocks')).n??incident.height;
   check(storedTip-ancestor<=maxDepth,'REORG_DEPTH_LIMIT');
   const end=Math.max(storedTip,incident.height,incident.trigger?.height??0);
   check(end-ancestor<=maxDepth,'REORG_DEPTH_LIMIT');
   incident.common_ancestor=ancestor;incident.reorg_depth=Math.max(0,storedTip-ancestor);incident.replay_end=end;
   const canonicalBlocks=[];let previous=(await quorum.get(ancestor)).block.hash;
   for(let n=ancestor+1;n<=end;n++){
    const agreed=await quorum.get(n);check(agreed.block.parent_hash===previous,'REORG_NO_PROVIDER_QUORUM');
    let full=null;
    for(const id of agreed.providers){try{const response=await e.rpc.request(quorum.providers.find(p=>p.id===id),'eth_getBlockByNumber',[hex(n),true],8000);if(response?.hash===agreed.block.hash&&response.parentHash===previous&&Array.isArray(response.transactions)){full=response;break;}}catch{}}
    check(full,'REORG_CANONICAL_BODY_UNAVAILABLE');canonicalBlocks.push(full);previous=agreed.block.hash;
   }
   const statements=[];
   for(const entry of quorum.evidence){
    const b=entry.blocks[incident.height];if(!entry.healthy||!b||b.hash===canonical.block.hash)continue;
    const quarantine={provider:entry.provider,reported_hash:b.hash,canonical_hash:canonical.block.hash,reason:'MINORITY_BLOCK_HASH_DISAGREEMENT',at:Date.now(),until_at:Date.now()+120000,incident_id:incident.id};
    statements.push(['INSERT INTO copy_provider_quarantine VALUES (?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET at=excluded.at,until_at=excluded.until_at,incident_id=excluded.incident_id,data=excluded.data',[entry.provider,quarantine.at,quarantine.until_at,incident.id,encode(quarantine)]]);
   }
   const rollback=await planReorgRollback(e.store,incident,canonicalBlocks);
   Object.assign(incident,rollback.audit,{phase:'REPLAYING',canonical_blocks:canonicalBlocks,replay_index:0,verified_boot:e.boot});
   for(const b of rollback.orphanBlocks)statements.push(archive(incident.id,'copy_blocks',String(b.number)+':'+b.hash,b));
   statements.push(...rollback.statements);
   for(const b of rollback.orphanBlocks)statements.push(['DELETE FROM copy_blocks WHERE number=? AND hash=?',[b.number,b.hash]]);
   // Retire every old notification for this range, with its original payload
   // archived. Canonical replay uses its own stable incident/block job key.
   const jobs=await e.store.all("SELECT * FROM copy_jobs WHERE (kind='BLOCK' AND json_extract(payload,'$.height') BETWEEN ? AND ?) OR (kind='TARGET' AND json_extract(payload,'$.block_number')>? AND json_extract(payload,'$.block_number')<=?)",Math.min(ancestor+1,incident.height),end,ancestor,end);
   for(const job of jobs){statements.push(archive(incident.id,'copy_jobs',job.id,job,'SUPERSEDED_BY_CANONICAL_REPLAY'));statements.push(["UPDATE copy_jobs SET state='REORGED_OUT',error='REORG_CANONICAL_REPLAY' WHERE id=?",[job.id]]);}
   for(const key of ['copy_cursor','copy_live_cursor']){const cursor=await e.store.setting(key);if(cursor>ancestor&&cursor<=end)statements.push(setting(key,ancestor));}
   statements.push(setting(KEY,incident),['UPDATE copy_reorg_incidents SET data=? WHERE id=?',[encode(incident),incident.id]]);
   // Every deletion of active state has a full immutable audit row in this same
   // transaction. A failed transaction cannot leave a half-repaired position.
   await e.store.batch(statements);
   e.blockReads.clear();e.seenHeads.clear();e.eventClocks?.clear();e.headClocks?.clear();e.pendingQuotes?.clear();e.price=null;
   e.reorgQuarantine=new Map((await activeQuarantines(e.store)).map(p=>[p.provider,p.until_at]));
   for(const [id,until] of e.reorgQuarantine)e.rpc.cooldown?.set(id,until);
  }
  if(incident.phase==='REPLAYING'){
   // A process restart must not replay yesterday's quorum as if it were a new
   // observation. Revalidate the saved canonical range before continuing.
   if(incident.verified_boot!==e.boot&&incident.canonical_blocks.length){
    const fresh=await canonicalEvidence(e.rpc,incident.height,{maxDepth});
    for(const b of incident.canonical_blocks){const agreed=await fresh.get(Number(BigInt(b.number)));check(agreed.block.hash===b.hash,'REORG_REPLAY_CHAIN_CHANGED');}
    incident.restart_provider_evidence=fresh.evidence;incident.verified_boot=e.boot;
   }
   for(let i=incident.replay_index??0;i<incident.canonical_blocks.length;i++){
    const b=incident.canonical_blocks[i],height=Number(BigInt(b.number));
    await e.commitCanonicalReorgBlock({height,expected_hash:b.hash,provider:'QUORUM',method:'REORG_CANONICAL_REPLAY',received_at:Date.now(),clock_boot:e.boot,reorg_id:incident.id},b);
    incident.replay_index=i+1;await saveIncident(e,incident,'RECONCILING');
   }
   incident.phase='RECOVERED';incident.final_status='RECOVERED';incident.reconciliation_finished_at=Date.now();
   const current=await e.store.setting('copy_config'),desired=await e.store.setting('engine_desired');
   const resume=current.epoch===incident.owned_epoch&&desired==='RUNNING'&&incident.previous_config.enabled;
   const statements=[];
   // Restore only operations interrupted by our own fence. Never undo a later
   // user STOP/policy change, and never replay a completed fill.
   if(resume){for(const a of incident.pending_actions??[]){const row=await e.store.get('SELECT state FROM copy_actions WHERE id=?',a.id);if(!row||['FILLED','REORGED_OUT'].includes(row.state))continue;statements.push(["UPDATE copy_actions SET state='DETECTED',epoch=?,data=?,reserved_raw='0',error=NULL WHERE id=?",[current.epoch,a.data,a.id]]);}statements.push(setting('copy_config',{...current,enabled:true,paused:incident.previous_config.paused,live_enabled:false,auto_armed:false}));}
   statements.push(setting(KEY,null),setting('copy_reorg_last',incident),['UPDATE copy_reorg_incidents SET status=?,data=? WHERE id=?',['RECOVERED',encode(incident),incident.id]]);
   await e.store.batch(statements);e.reorgActive=false;e.key=null;
   await e.report('REORG_RECOVERED','Canonical replay complete; watcher may resume',{id:incident.id,height:incident.height,classification:incident.classification,depth:incident.reorg_depth,resumed:resume});
  }
  return true;
 }catch(error){
  const transient=/^RPC_|PROVIDER_BEHIND|PROVIDER_HEAD_STALE|REORG_CANONICAL_BODY_UNAVAILABLE|SQLITE_BUSY/.test(error.message);
  incident.final_status=transient?'RECONCILING':'MANUAL_REVIEW';incident.manual_reason=error.message;incident.retry_at=Date.now()+30000;
  // A transient quorum loss is retried at a bounded rate. No chain/position
  // mutation happens until evidence is sufficient.
  await saveIncident(e,incident,incident.final_status);await e.report('REORG_REVIEW',error.message,{id:incident.id,height:incident.height});return false;
 }finally{e.reorgRecoveryBusy=false;}
}

export {archive as reorgArchive};
