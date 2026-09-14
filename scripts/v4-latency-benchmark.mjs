import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
import {RouteEngine as After} from '../runtime/copy/routes.mjs';
import {writeEvidence} from './v4-evidence-io.mjs';
if(!process.env.V4_BASELINE_DIR)throw Error('V4_BASELINE_DIR_REQUIRED');
const {RouteEngine:Before}=await import(pathToFileURL(resolve(process.env.V4_BASELINE_DIR,'runtime/copy/routes.mjs')));
const request={paper:true,token:'0x'+'1'.repeat(40),side:'BUY',amount:'2000000000000000',hints:[{adapter:'FLAP_PORTAL',address:'0x'+'2'.repeat(40)}]};
function delay(ms,signal){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal?.addEventListener('abort',abort,{once:true});});}
const results={};for(const [name,Engine] of [['before',Before],['after',After]]){const samples=[];for(let i=0;i<10;i++){const engine=new Engine({});engine.providers=[{id:'FLAP_PORTAL',quote:async r=>{await delay(400,r.signal);throw Error('CONTROLLED_SLOW_ROUTE');}},{id:'PANCAKE_V2',quote:async r=>{await delay(30,r.signal);return {provider:'PANCAKE_V2',impact_pct:0,out_raw:'1000000',min_out_raw:'970000'};}}];const start=performance.now(),q=await engine.quote(request,{allowUnknownImpact:true});if(q.min_out_raw!=='970000')throw Error('TERMS_CHANGED');samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);results[name]={samples,p50_ms:samples[4]};}
writeEvidence('controlled-quote-latency',{method:'SYNTHETIC_IDENTICAL_ROUTE_RESPONSES: preferred failure at 400ms, fallback success at 30ms; no RPC or PAPER reaction claim',results});console.log(JSON.stringify(results));
