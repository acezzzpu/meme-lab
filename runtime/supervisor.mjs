import {fork} from 'node:child_process';
import {emit} from '../core/engine-state.mjs';
export function supervise(store){
 let child=null,closed=false,lastBeat=Date.now(),restartTimer=null,failures=0;
 const launch=()=>{if(closed)return;lastBeat=Date.now();child=fork(new URL('./engine.mjs',import.meta.url),[],{env:process.env,stdio:['ignore','inherit','inherit','ipc']});
  child.on('message',message=>{if(message.kind==='heartbeat'||message.kind==='standby')lastBeat=Date.now();if(message.kind==='heartbeat'&&message.active?.some(job=>Date.now()-job.at>180000)){emit(store,'ERROR','Watchdog: trabajo bloqueado, reiniciando motor').catch(()=>{});child?.kill('SIGKILL');}});
  child.on('exit',(code,signal)=>{child=null;if(closed)return;failures++;emit(store,'RECOVERY','Watchdog reinicia el proceso del motor',{code,signal,restarts:failures}).catch(()=>{});restartTimer=setTimeout(launch,Math.min(10000,1000*failures));});
 };
 launch();const watchdog=setInterval(()=>{if(child&&Date.now()-lastBeat>30000){emit(store,'ERROR','Watchdog: proceso sin heartbeat').catch(()=>{});child.kill('SIGKILL');}},5000);
 return {get pid(){return child?.pid??null;},async stop(){closed=true;clearInterval(watchdog);clearTimeout(restartTimer);if(!child)return;const target=child;await new Promise(resolve=>{target.once('exit',resolve);target.kill('SIGTERM');const timer=setTimeout(()=>target.kill('SIGKILL'),17000);timer.unref();});}};
}
