import {testRateLimitFailover} from './failover-test.mjs';
import {decode,cleanError} from '../../core/copy/common.mjs';
export async function runCopySelfTest(e){
 const rows=[],at=Date.now();const add=(name,pass,detail,critical=true)=>rows.push({name,status:pass?'PASS':'FAIL',critical,detail});
 const providers=e.rpc.providers.filter(p=>!['archive','benchmark'].includes(p.role));
 for(const role of ['primary','secondary']){
  const p=providers.find(p=>p.role===role)??providers[role==='primary'?0:1];
  if(!p){add('HTTP_'+role.toUpperCase(),false,'PROVIDER_NOT_CONFIGURED');add('WS_'+role.toUpperCase(),false,'PROVIDER_NOT_CONFIGURED');continue;}
  try{const start=performance.now();const chain=await e.rpc.request(p,'eth_chainId');add('HTTP_'+role.toUpperCase(),chain==='0x38',{provider:p.id,latency_ms:performance.now()-start});}catch(error){add('HTTP_'+role.toUpperCase(),false,{provider:p.id,error:cleanError(error)});}
  const row=await e.store.get('SELECT * FROM copy_provider_health WHERE id=?',p.id),health=decode(row?.data);
  add('WS_'+role.toUpperCase(),!!p.ws_url&&health.ws?.status==='CONNECTED'&&Date.now()-(health.ws?.last_head_at??0)<10000,{provider:p.id,health});
 }
 const health=(await e.store.all('SELECT data FROM copy_provider_health')).map(r=>decode(r.data));
 add('NEW_HEADS',health.some(h=>(h.head_seen_count??0)>0),'Requires actual received head messages');
 const pending=health.some(h=>(h.pending_seen_count??0)>0);rows.push({name:'PENDING_STREAM',status:pending?'PASS':'UNSUPPORTED',critical:false,detail:pending?'Real received pending messages':'Confirmed block capture remains required; no hash lookup fanout'});
 const events=(await e.store.all('SELECT * FROM copy_events')).map(r=>({...r,data:decode(r.data)}));
 const targets=await e.store.all('SELECT id,address FROM copy_targets');const addresses=new Map(targets.map(t=>[t.id,t.address]));
 const actual=events.filter(r=>r.status==='CONFIRMED'&&!r.data.history&&r.detected_at>=e.boot),actions=(await e.store.all("SELECT * FROM copy_actions WHERE mode='PAPER' AND state='FILLED'")).map(r=>({...r,data:decode(r.data)})).filter(r=>!r.data.event?.history&&r.created_at>=e.boot);
 add('TARGET_FILTER',actual.length>0&&actual.filter(r=>r.data.side).every(r=>r.data.from===addresses.get(r.target_id)),'Real confirmed sources must belong to the configured sender');
 add('RECEIPT_FETCH',actual.length>0,'Requires at least one confirmed receipt');
 add('TRANSFER_DECODER',actual.some(r=>r.data.flows?.length>0),'Requires real decoded token movements');
 add('BUY_DECODER',actual.some(r=>r.data.side==='BUY'),'Requires a real observed BUY');
 add('SELL_DECODER',actual.some(r=>r.data.side==='SELL'),'Requires a real observed SELL');
 add('PARTIAL_SELL',actual.some(r=>r.kind==='PARTIAL_SELL'&&r.data.sold_fraction>0&&r.data.sold_fraction<1),'Requires a real partial sale with balance evidence');
 add('PAPER_BUY',actions.some(r=>r.side==='BUY'),'Requires an observed target BUY and own PAPER fill');
 add('PAPER_SELL',actions.some(r=>r.side==='SELL'),'Requires an observed target SELL and own PAPER fill');
 add('ROUTE_QUOTE',actions.some(r=>r.data.quote?.out_raw),'Requires an own real market quote and PAPER fill');
 add('ZEROX_QUOTE',actions.some(r=>r.data.quote?.provider==='ZEROX_ALLOWANCE_HOLDER'),e.keys?.zeroEx?'No successful measured quote yet':'ZEROX_KEY_NOT_CONFIGURED',false);
 add('FOT_HANDLING',actions.some(r=>r.data.quote?.tax_classification==='BUY_SELL_TAX'),'Optional token-specific tax evidence; UNKNOWN is never zero tax',false);
 const ledger=await e.store.get("SELECT COUNT(*) n FROM copy_ledger WHERE mode='PAPER'"),positions=await e.store.all("SELECT quantity_raw,cost_raw FROM copy_positions WHERE mode='PAPER'");
 add('POSITION_RECONCILIATION',actions.length>0&&ledger.n===actions.length&&positions.every(p=>BigInt(p.quantity_raw)>=0n&&BigInt(p.cost_raw)>=0n),'One ledger fill per action; nonnegative inventory and cost');
 const duplicate=await e.store.get('SELECT COUNT(*) n FROM (SELECT event_id,mode,COUNT(*) n FROM copy_actions GROUP BY event_id,mode HAVING n>1)');
 add('DUPLICATE_PROTECTION',actual.length>0&&duplicate.n===0,'Durable event/mode uniqueness');
 const failover=await testRateLimitFailover(e);add('RATE_LIMIT_FAILOVER',failover.passed,failover);const backfill=await e.store.setting('copy_backfill');add('BACKFILL_PAUSE',backfill?.live_quota_access===false,backfill??'No backfill budget evidence');
 const result={at,completed_at:Date.now(),status:rows.every(r=>!r.critical||r.status==='PASS')?'PASS':'BLOCKED',acceptance_passed:false,checks:rows};await e.store.set('copy_self_test',result);return result;
}
