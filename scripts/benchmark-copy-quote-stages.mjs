import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {Store} from '../core/store.mjs';
import {freeBscProviders} from '../runtime/copy/provider-config.mjs';
import {QuoteTrace} from '../runtime/copy/quote-profile.mjs';
const BASE='4285248983af442dee974582b304a32e7888eeab',names=['rpc','routes','paper-dex-route','smart-routes','quote-selection','flap'];
const id=process.argv[2],hash=process.argv[3];if(!['PANCAKE_V2','PANCAKE_SMART','PAPER_DEX_PATH','FLAP_PORTAL'].includes(id)||!/^0x[0-9a-f]{64}$/.test(hash??''))throw Error('PROVIDER_AND_EXISTING_HASH_REQUIRED');
// A read-only source snapshot in separate diagnostic files. Never checkout,
// reset, update a branch or alter the running worker's imports.
const snapshot=JSON.parse(readFileSync(new URL('../tests/fixtures/quote-baseline-4285248.json',import.meta.url),'utf8'));if(snapshot.commit!==BASE)throw Error('QUOTE_BASELINE_MISMATCH');
for(const name of names){let src=snapshot.sources[name];for(const dep of names)src=src.replaceAll("'./"+dep+".mjs'","'./diagnostic-before-"+dep+".mjs'");writeFileSync(resolve('runtime/copy/diagnostic-before-'+name+'.mjs'),src);}
const db=sqliteDriver(resolve(process.env.DATA_DIR??'data','meme-lab.sqlite')),store=new Store(db),row=await store.get("SELECT a.data FROM copy_actions a JOIN copy_events e ON e.id=a.event_id WHERE a.mode='PAPER' AND e.hash=?",hash);if(!row)throw Error('EXISTING_ACTION_REQUIRED');const a=JSON.parse(row.data),c=await store.setting('copy_config');
const results=[],providers=freeBscProviders();let totalReads=0;
for(const version of ['BEFORE','AFTER']){
 const prefix=version==='BEFORE'?'diagnostic-before-':'';const {BscRpc}=await import(pathToFileURL(resolve('runtime/copy/'+prefix+'rpc.mjs'))),{RouteEngine}=await import(pathToFileURL(resolve('runtime/copy/'+prefix+'routes.mjs'))),rpc=new BscRpc(providers),engine=new RouteEngine(rpc),adapter=engine.providers.find(p=>p.id===id);
 for(const cache of ['COLD','WARM']){
  const trace=new QuoteTrace(id),start=performance.now();let result;
  try{const quote=await rpc.withContext({quoteTrace:trace,priority:-1,pipeline:'BOUNDED_QUOTE_STAGE_EXPERIMENT',beforeRequest:()=>{if(++totalReads>80)throw Error('DIAGNOSTIC_TOTAL_READ_CAP');}},()=>adapter.quote({paper:true,side:a.quote.side,token:a.quote.token,amount:a.quote.amount_raw,slippageBps:c.max_slippage_bps,taker:'0x00000000000000000000000000000000b0bc0f56',hints:a.event?.pools??[],candidatePools:a.event?.candidate_pools??a.quote.candidate_pools??[]}));result={status:'QUOTED',quote};}catch(error){result={status:'FAILED',error:error.message};}
  trace.finished=performance.now();results.push({version,cache,wall_ms:performance.now()-start,profile:trace.snapshot(),...result});
  // Complete any outstanding immutable reads before a new measurement.
  await Promise.allSettled([...rpc.cacheFlights.values()]);
 }
}
const result={at:Date.now(),source:'ACTUAL_RENDER_BOUNDED_STORED_EVENT_CURRENT_QUOTES',target_hash:hash,provider:id,before_commit:BASE,after_commit:process.env.RENDER_GIT_COMMIT,total_reads:totalReads,production_quote_selection_changed:false,market_state_note:'Current block read for each quote; outputs are not a same-block equivalence test. See separate V2 equivalence evidence.',results};await store.set('copy_quote_stage_benchmark:'+id,result);console.log(JSON.stringify({provider:id,total_reads:totalReads,rows:results.map(r=>({version:r.version,cache:r.cache,status:r.status,error:r.error,wall_ms:r.wall_ms,rpc:r.profile.rpc_calls,phases:r.profile.phases_ms,queue_sum_ms:r.profile.queue_sum_ms,wire_sum_ms:r.profile.wire_sum_ms}))}));db.close();
