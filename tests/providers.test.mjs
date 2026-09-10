import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {sqliteDriver} from '../runtime/sqlite.mjs';
import {checkHealth} from '../core/providers/chains.mjs';
import {handle} from '../core/service.mjs';
import {providerErrorMessage,SOLANA_PUBLIC_RPC} from '../core/provider-status.mjs';
import {validateEndpoint} from '../core/util.mjs';

const genesis='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
async function fixture(t){const driver=sqliteDriver(':memory:');t.after(()=>driver.close());const store=new Store(driver);await store.init();return store;}
function rpcResponse(_url,options){const {method}=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:1,result:method==='getGenesisHash'?genesis:123456});}

test('failed RPC health exposes the cause and clears stale success indicators',async t=>{
 const store=await fixture(t),chain=await store.get("SELECT * FROM chains WHERE id='solana'");
 const mocked=t.mock.method(globalThis,'fetch',rpcResponse);await checkHealth(store,chain);
 mocked.mock.mockImplementation(async()=>new Response('',{status:403}));
 const result=await checkHealth(store,chain),row=await store.get("SELECT * FROM provider_health WHERE id='solana'");
 assert.match(result.error,/^PROVIDER_HTTP_403 api\.mainnet-beta\.solana\.com$/);assert.equal(row.status,'ERROR');assert.equal(row.latency_ms,null);assert.equal(row.block,null);assert.ok(row.last_success);assert.match(providerErrorMessage(result.error),/Acceso rechazado/);
});
test('rejected replacement keeps existing RPC and running sessions unchanged',async t=>{
 const store=await fixture(t);await store.set('trading_enabled',true);await store.set('mode','PAPER');
 t.mock.method(globalThis,'fetch',async()=>new Response('',{status:403}));
 await assert.rejects(handle(store,'settings/network','POST',{chain:'solana',enabled:true,rpc_url:SOLANA_PUBLIC_RPC}),/403.*configuración anterior/);
 assert.equal((await store.get("SELECT rpc_url FROM chains WHERE id='solana'")).rpc_url,'https://api.mainnet-beta.solana.com');assert.equal(await store.setting('trading_enabled'),true);assert.equal(await store.setting('epoch'),0);
});
test('wrong network cannot replace the Solana mainnet RPC',async t=>{
 const store=await fixture(t);
 t.mock.method(globalThis,'fetch',async(_url,options)=>Response.json({result:JSON.parse(options.body).method==='getGenesisHash'?'wrong-network':123}));
 await assert.rejects(handle(store,'settings/network','POST',{chain:'solana',enabled:true,rpc_url:SOLANA_PUBLIC_RPC}),/otra red/);
 assert.equal(await store.setting('epoch'),0);
});
test('verified replacement records health and invalidates previous trading state',async t=>{
 const store=await fixture(t);await store.set('trading_enabled',true);
 const mocked=t.mock.method(globalThis,'fetch',rpcResponse);
 const result=await handle(store,'settings/network','POST',{chain:'solana',enabled:true,rpc_url:SOLANA_PUBLIC_RPC});
 assert.equal(result.verified,true);assert.equal(result.status,'CONNECTED');assert.equal(result.trading_stopped,true);
 assert.equal((await store.get("SELECT rpc_url FROM chains WHERE id='solana'")).rpc_url,SOLANA_PUBLIC_RPC);
 assert.equal((await store.get("SELECT status FROM provider_health WHERE id='solana'")).status,'CONNECTED');assert.equal(await store.setting('trading_enabled'),false);assert.equal(await store.setting('epoch'),1);
 assert.deepEqual(mocked.mock.calls.map(c=>JSON.parse(c.arguments[1].body).method).sort(),['getGenesisHash','getSlot']);
});
test('PublicNode is allowed only under the approved HTTPS host',()=>{
 assert.equal(validateEndpoint(SOLANA_PUBLIC_RPC),SOLANA_PUBLIC_RPC);
 assert.throws(()=>validateEndpoint(SOLANA_PUBLIC_RPC+'.attacker.example'));
 assert.throws(()=>validateEndpoint('http://solana-rpc.publicnode.com'));
 assert.match(providerErrorMessage('PROVIDER_HTTP_429'),/Límite/);
 assert.match(providerErrorMessage('The operation was aborted due to timeout'),/tiempo/);
});
