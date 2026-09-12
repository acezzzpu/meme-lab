import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import {setImmediate as turn} from 'node:timers/promises';
import {streamSse} from '../runtime/sse.mjs';
function fixture(){
 const req=new EventEmitter(),res=new EventEmitter(),socket=new EventEmitter();socket.writable=true;res.socket=socket;
 res.writes=[];res.writeHead=()=>{};res.flushHeaders=()=>{};
 res.write=s=>{assert.ok(!res.writableEnded&&!res.destroyed&&!socket.destroyed,'write after close');res.writes.push(s);};
 res.end=()=>{res.writableEnded=true;res.emit('finish');};res.destroy=()=>{res.destroyed=true;res.emit('close');};
 let closes=0;const options={loadCursor:async()=>1,eventsAfter:async()=>[],state:async()=>({ok:true}),onClose:()=>closes++};
 return {req,res,socket,options,closes:()=>closes};
}
for(const signal of ['close','finish','socket-close','aborted'])test('SSE disconnect during async state: '+signal,async()=>{
 const f=fixture();let resolve,entered;const ready=new Promise(r=>entered=r);f.options.state=()=>{entered();return new Promise(r=>resolve=r);};
 const running=streamSse(f.req,f.res,f.options);await ready;
 if(signal==='close')f.res.destroy();else if(signal==='finish')f.res.end();else if(signal==='socket-close'){f.socket.destroyed=true;f.socket.emit('close');}else{f.req.aborted=true;f.req.emit('aborted');}
 resolve({late:true});await running;await turn();assert.deepEqual(f.res.writes,[]);assert.equal(f.closes(),1);
 assert.equal(f.res.listenerCount('close')+f.res.listenerCount('finish')+f.res.listenerCount('error'),0);
 assert.equal(f.req.listenerCount('aborted')+f.socket.listenerCount('close'),0);
});
test('response ends while awaiting events: no event or snapshot write',async()=>{
 const f=fixture();f.options.eventsAfter=async()=>{f.res.writableEnded=true;return [{id:2}];};await streamSse(f.req,f.res,f.options);await turn();assert.deepEqual(f.res.writes,[]);assert.equal(f.closes(),1);
});
test('response ends between events: every write is fenced',async()=>{
 const f=fixture();f.options.eventsAfter=async()=>[{id:2},{id:3}];const write=f.res.write;f.res.write=s=>{write(s);f.res.end();};await streamSse(f.req,f.res,f.options);await turn();assert.equal(f.res.writes.length,1);
});
test('already ended response has no headers, writes or timers',async()=>{
 const f=fixture();f.res.writableEnded=true;f.res.writeHead=()=>assert.fail('headers after end');await streamSse(f.req,f.res,f.options);await turn();assert.equal(f.closes(),1);
});
test('asynchronous response error is handled and stops the interval',async()=>{
 const f=fixture();let calls=0;f.options.intervalMs=1;f.options.state=async()=>{calls++;return {};};await streamSse(f.req,f.res,f.options);
 f.res.emit('error',Object.assign(Error('write after end'),{code:'ERR_STREAM_WRITE_AFTER_END'}));await turn();assert.equal(f.closes(),1);assert.equal(f.res.listenerCount('error'),0);assert.equal(calls,1);
});
test('queued error preceding finish is handled before listeners are removed',async()=>{
 const f=fixture();f.res.write=()=>{process.nextTick(()=>f.res.emit('error',Error('queued transport error')));f.res.end();};await streamSse(f.req,f.res,f.options);await turn();assert.equal(f.closes(),1);
});
test('real HTTP client disconnect during pending snapshot leaves server healthy',async t=>{
 let release,started,closed;const stateStarted=new Promise(r=>started=r),streamClosed=new Promise(r=>closed=r);
 const server=http.createServer((req,res)=>{streamSse(req,res,{initialCursor:1,eventsAfter:async()=>[],state:()=>{started();return new Promise(r=>release=r);},onClose:closed});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const client=http.get({host:'127.0.0.1',port:server.address().port,path:'/'},res=>res.destroy());client.on('error',()=>{});
 await stateStarted;await streamClosed;release({late:true});await turn();await turn();assert.equal(server.listening,true);
});
