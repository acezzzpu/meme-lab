import {Worker} from 'node:worker_threads';
// One reader and one cached payload for all clients. No trading DB writes.
export class DashboardReader {
 constructor(filename,options={}){
  this.snapshot=null;this.error=null;this.pending=new Map();this.sequence=0;
  this.worker=new Worker(new URL('./dashboard-worker.mjs',import.meta.url),{workerData:{filename,options}});
  this.worker.on('message',m=>{if(m.requestId){const p=this.pending.get(m.requestId);if(p){clearTimeout(p.timer);this.pending.delete(m.requestId);m.error?p.reject(Error(m.error)):p.resolve(m.result);}return;}if(m.error)this.error=m.error;else{this.snapshot=m;this.error=null;}});
  this.worker.on('error',e=>{this.error=e.message;});
  this.worker.on('exit',()=>{this.error='DASHBOARD_READER_STOPPED';});
 }
 read(){if(this.error)throw Error(this.error);if(!this.snapshot)throw Error('DASHBOARD_READER_STARTING');return this.snapshot;}
 request(kind,options){if(this.pending.size>=4)return Promise.reject(Error('DASHBOARD_HISTORY_BUSY'));const requestId=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('DASHBOARD_HISTORY_TIMEOUT'));},10000);this.pending.set(requestId,{resolve,reject,timer});this.worker.postMessage({kind,requestId,options});});}
 history(options){return this.request('history',options);}
 bootstrap(){return this.request('bootstrap',{});}
 close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('DASHBOARD_CLOSED'));}this.pending.clear();return this.worker.terminate();}
}
