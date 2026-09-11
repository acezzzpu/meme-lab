import test from 'node:test';
import assert from 'node:assert/strict';
import {BscRpc} from '../runtime/copy/rpc.mjs';

test('receipt preference reduces successful receipt requests to one without changing full-block primary',async()=>{
 const ps=[{id:'head',http_url:'head',enabled:true},{id:'receipt',http_url:'receipt',enabled:true,receipt_primary:true}],sent=[];
 const r=new BscRpc(ps,{fetcher:async(url,{body})=>{sent.push([url,JSON.parse(body).method]);return new Response(JSON.stringify({result:{hash:'same-proof'}}));}});ps.forEach(p=>r.verified.add(p.id));
 assert.equal((await r.call('eth_getTransactionReceipt',['hash'])).hash,'same-proof');await r.call('eth_getBlockByNumber',['0x1',true]);
 assert.deepEqual(sent,[['receipt','eth_getTransactionReceipt'],['head','eth_getBlockByNumber']]);assert.equal(r.failover.successes,0);
});
test('preferred receipt provider 429 still fails over and records the actual wire cost',async()=>{
 const ps=[{id:'head',http_url:'head',enabled:true},{id:'receipt',http_url:'receipt',enabled:true,receipt_primary:true}],sent=[];
 const r=new BscRpc(ps,{fetcher:async(url)=>{sent.push(url);return url==='receipt'?new Response(JSON.stringify({error:{message:'rate limit'}}),{status:429}):new Response(JSON.stringify({result:{status:'0x1'}}));}});ps.forEach(p=>r.verified.add(p.id));
 assert.equal((await r.call('eth_getTransactionReceipt',['hash'])).status,'0x1');assert.deepEqual(sent,['receipt','head']);assert.equal(r.failover.successes,1);assert.equal(r.telemetry.snapshot(ps).providers.reduce((n,p)=>n+p.requests,0),2);
});
test('explicit archive-token 403 suppresses only receipts; block capture remains available',async()=>{
 const ps=[{id:'public',http_url:'public',enabled:true},{id:'backup',http_url:'backup',enabled:true}],sent=[];
 const r=new BscRpc(ps,{fetcher:async(url,{body})=>{const m=JSON.parse(body).method;sent.push([url,m]);return url==='public'&&m==='eth_getTransactionReceipt'?new Response(JSON.stringify({error:{message:'Archive requests require a personal token. Get one at: provider'}}),{status:403}):new Response(JSON.stringify({result:{status:'0x1'}}));}});ps.forEach(p=>r.verified.add(p.id));
 await r.call('eth_getTransactionReceipt',['a']);await r.call('eth_getTransactionReceipt',['b']);await r.call('eth_getBlockByNumber',['0x1',true]);
 assert.equal(sent.filter(([p,m])=>p==='public'&&m==='eth_getTransactionReceipt').length,1);assert.deepEqual(sent.at(-1),['public','eth_getBlockByNumber']);assert.equal(r.cooldown.has('public'),false);
});

