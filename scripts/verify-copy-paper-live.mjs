import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {runtimeContext} from '../runtime/context.mjs';
import {runCopySelfTest} from '../runtime/copy/self-test.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {handleCopy,copySummary} from '../core/copy/service.mjs';
import {targetDefaults} from '../core/copy/schema.mjs';

const directory=process.env.COPY_PROOF_DIR;if(!directory)throw Error('COPY_PROOF_DIR_REQUIRED_ISOLATED_DIRECTORY');
process.env.DATA_DIR=resolve(directory);
const {store,db,options}=await runtimeContext();
const target='0x80a65fcaeabbb0aa4c9a85087f9e0f7ba26f293f';
if(!store.options.copyProviders?.length){await store.set('copy_providers',[{id:'publicnode-observation',label:'PublicNode diagnostic only',http_url:'https://bsc-rpc.publicnode.com',ws_url:'wss://bsc-rpc.publicnode.com',enabled:true,pending:'STANDARD_FULL'},{id:'bnb-observation',label:'BNB public diagnostic only',http_url:'https://bsc-dataseed.bnbchain.org',ws_url:null,enabled:true,pending:'NONE'}]);}
if(!await store.get('SELECT id FROM copy_targets WHERE id=?',target))await handleCopy(store,'copy/target','POST',{address:target,label:'Requested BSC target',enabled:true,config:{...targetDefaults,mode:'PAPER'}},options);
await handleCopy(store,'copy/start','POST',{},options);
const e=new CopyEngine(store,{...options,paperOnly:true});await e.start();
const started=Date.now(),duration=Number(process.env.COPY_PROOF_DURATION_MS??900000);let stopped=false;
async function save(final=false){const s=await copySummary(store);const data={label:'REAL_TIME_PAPER_OBSERVATION',started_at:started,at:Date.now(),target,final,providers:s.providers,events:s.events,actions:s.actions,positions:s.positions,accounts:s.accounts,health:s.health,runtime:s.runtime,latencies:s.latencies_v2,self_test:s.self_test,source_transactions:s.source_transactions,acceptance_passed:false};
 const buys=s.actions.filter(a=>a.mode==='PAPER'&&a.side==='BUY'&&a.state==='FILLED'&&!a.data.event?.history),sells=s.actions.filter(a=>a.mode==='PAPER'&&a.side==='SELL'&&a.state==='FILLED'&&!a.data.event?.history);data.candidates={paper_buys:buys.length,paper_sells:sells.length};
 // Manual evidence review is still required; counts alone never certify success.
 await fs.writeFile(resolve(directory,'live-proof.json'),JSON.stringify(data,null,2));console.log(JSON.stringify({at:data.at,events:s.events.length,buy_fills:buys.length,sell_fills:sells.length,status:s.runtime?.status,last_errors:s.actions.filter(a=>a.error).slice(0,2).map(a=>a.error)}));
}
async function finish(){if(stopped)return;stopped=true;clearInterval(timer);await runCopySelfTest(e);await e.stop();await save(true);db.close();}
const timer=setInterval(()=>save().catch(err=>console.log(JSON.stringify({error:err.message}))),30000);
process.once('SIGINT',()=>finish().then(()=>process.exit(0)));process.once('SIGTERM',()=>finish().then(()=>process.exit(0)));
console.log(JSON.stringify({started_at:started,duration_ms:duration,mode:'PAPER_ONLY_NO_SIGNER',directory}));
while(!stopped&&Date.now()-started<duration)await new Promise(r=>setTimeout(r,500));await finish();
