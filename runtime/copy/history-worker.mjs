import {runtimeContext} from '../context.mjs';
import {CopyEngine} from './engine.mjs';
import {blockWork} from './block-worker.mjs';
if(!process.connected)process.exit(0);
const {db,store,options}=await runtimeContext();
const engine=new CopyEngine(store,{...options,historicalOnly:true,liveBoot:Number(process.env.COPY_LIVE_BOOT_AT)||Date.now()});
let stopped=false;
async function stop(){stopped=true;await engine.stop();db.close();process.exit(0);}
process.on('disconnect',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
if(!process.connected)await stop();
while(!stopped){
 try{if(Date.now()-engine.lastRefresh>5000)await engine.refresh();await blockWork(engine,true);const active=(await store.setting('copy_config')).enabled&&await store.setting('engine_desired')==='RUNNING';await engine.work({archiveOnly:active,diagnosticOnly:!active});}
 catch(error){await engine.report('HISTORY_ERROR',String(error.message).slice(0,180));}
 await new Promise(r=>setTimeout(r,1500));
}
