import {resolve} from 'node:path';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {Store} from '../core/store.mjs';
import {decode} from '../core/copy/common.mjs';
import {copyDegradation} from '../core/copy/degradation.mjs';
const db=sqliteDriver(resolve(process.env.DATA_DIR??'data','meme-lab.sqlite')),store=new Store(db);
const rows=await store.all("SELECT e.target_id,e.data target,a.data action,a.state,p.data profile FROM copy_events e LEFT JOIN copy_actions a ON a.event_id=e.id AND a.mode='PAPER' LEFT JOIN copy_latency_profiles p ON p.event_id=e.id WHERE e.status='CONFIRMED' ORDER BY e.block,e.tx_index");
const result=copyDegradation(rows.map(r=>({...r,target:decode(r.target),action:decode(r.action),profile:decode(r.profile)})));result.production_commit=process.env.RENDER_GIT_COMMIT;await store.set('copy_degradation_report',result);
console.log(JSON.stringify({completed:result.completed_cycles.length,incomplete_closed:result.incomplete_closed_cycles.length,open:result.open_observed_cycles.length,cycles:result.completed_cycles.map(x=>({token:x.token,target_return_pct:x.target_return_pct,paper_return_pct:x.paper_return_pct,difference_pp:x.difference_pp,classification:x.target_return_classification}))}));db.close();
