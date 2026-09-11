import test from 'node:test';
import assert from 'node:assert/strict';
import {BscRpc} from '../runtime/copy/rpc.mjs';
import {copyEnvironment,historyReadProviders} from '../runtime/copy/provider-config.mjs';
import {WalletActivityProvider} from '../runtime/copy/activity-provider.mjs';

test('a quota rejection during WS chain verification closes the unusable socket for retry',()=>{
 let closed=false;const health=[];
 const p=new WalletActivityProvider({id:'p',ws_url:'wss://unit.invalid'}, {}, [],()=>{},(_id,status,data)=>health.push({status,data}));
 p.socket={readyState:1,close:()=>{closed=true;}};p.requests.set(1,'chain');
 p.message({id:1,error:{code:-32003,message:'daily request limit reached'}});
 assert.equal(closed,true);assert.equal(p.verified,false);assert.equal(p.subscriptions.size,0);
 assert.equal(health[0].status,'ERROR');assert.match(health[0].data.error,/daily request limit reached/);
});

test('queued recovery reads are paced and urgent reads take the next available start',async()=>{
 const p={id:'p',enabled:true,http_url:'https://unit.invalid',requests_per_second:20};
 const starts=[];
 const rpc=new BscRpc([p],{fetcher:async(_url,{body})=>{starts.push({method:JSON.parse(body).method,at:performance.now()});return new Response(JSON.stringify({result:'0x1'}));}});
 rpc.verified.add('p');
 await rpc.call('seed');
 const background=rpc.withContext({priority:-2},()=>Promise.all([rpc.call('background-a'),rpc.call('background-b')]));
 const urgent=rpc.withContext({priority:1},()=>rpc.call('urgent'));
 await Promise.all([background,urgent]);
 assert.deepEqual(starts.map(s=>s.method),['seed','urgent','background-a','background-b']);
 for(let i=1;i<starts.length;i++)assert.ok(starts[i].at-starts[i-1].at>=45,'A backlog must not burst above the configured rate');
});

test('aborting a paced queued read never sends it or blocks a later read',async()=>{
 const p={id:'p',enabled:true,http_url:'https://unit.invalid',requests_per_second:20},sent=[];
 const rpc=new BscRpc([p],{fetcher:async(_url,{body})=>{sent.push(JSON.parse(body).method);return new Response(JSON.stringify({result:'0x1'}));}});rpc.verified.add('p');
 await rpc.call('seed');
 const controller=new AbortController(),cancelled=rpc.withContext({signal:controller.signal},()=>rpc.call('cancelled'));
 controller.abort(Error('cancelled before start'));
 await assert.rejects(cancelled,/cancelled before start/);
 await rpc.call('next');assert.deepEqual(sent,['seed','next']);assert.equal(rpc.status()[0].active,0);
});

test('environment defaults reserve separate live and history request budgets',()=>{
 const env={BSC_PRIMARY_HTTP:'https://bsc-rpc.publicnode.com'};
 const live=copyEnvironment(env).providers,history=historyReadProviders(live);
 assert.equal(live[0].requests_per_second,8);assert.deepEqual(history,[]);
 assert.equal(live[0].requests_per_second,8,'History must not mutate the live provider');
 assert.equal(copyEnvironment({...env,BSC_PRIMARY_RPS:'35'}).providers[0].requests_per_second,35);
 assert.throws(()=>copyEnvironment({...env,BSC_PRIMARY_RPS:'0'}),/RPS_INVALID/);
 const dedicated=historyReadProviders([...live,{id:'archive',role:'archive',enabled:true,requests_per_second:8,history_dedicated:true,http_url:'https://separate.invalid'}]);
 assert.deepEqual(dedicated.map(p=>p.id),['archive']);assert.equal(dedicated[0].role,'primary');
});
