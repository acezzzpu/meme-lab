import {gunzipSync} from 'node:zlib';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {runtimeContext} from '../runtime/context.mjs';
import {CopyEngine} from '../runtime/copy/engine.mjs';
import {handleCopy,copySummary} from '../core/copy/service.mjs';
import {decode} from '../core/copy/common.mjs';
const directory=process.env.COPY_REPLAY_DIR;if(!directory)throw Error('COPY_REPLAY_DIR_REQUIRED_ISOLATED_DIRECTORY');
process.env.DATA_DIR=resolve(directory);
const {store,db,options}=await runtimeContext();
if((await store.get('SELECT COUNT(*) n FROM copy_events')).n)throw Error('REPLAY_REQUIRES_EMPTY_ISOLATED_DATABASE');
const fixture=JSON.parse(gunzipSync(Buffer.from(await fs.readFile(new URL('../tests/fixtures/bnb-target-20260910/sample.json.gz.b64',import.meta.url),'utf8'),'base64'))),cache=JSON.parse(await fs.readFile(new URL('../tests/fixtures/bnb-target-20260910/rpc.json',import.meta.url)));
await handleCopy(store,'copy/start','POST',{},options);
const e=new CopyEngine(store,{...options,paperOnly:true,historicalReplay:true});await e.refresh();for(const stream of e.streams)stream.stop();
const actualRpc=e.rpc;
const results=[];
for(const s of fixture.samples){
 // Only historical receipt/balance evidence is replayed. RouteEngine retains its
 // real HTTP RPC and fetches OUR current market quote; no synthetic fills.
 e.rpc={call:async(method,params=[])=>method==='eth_getTransactionReceipt'?s.receipt:cache[JSON.stringify([method,params])]??Promise.reject(Error('HISTORICAL_RPC_NOT_CAPTURED')),contract:async(to,abi,method,args=[],block='latest')=>abi.decodeFunctionResult(method,cache[JSON.stringify(['eth_call',[{to,data:abi.encodeFunctionData(method,args)},block]])]??'0x')};
 await e.ingest({target:fixture.provenance.target,hash:s.tx.hash,tx:s.tx,block:s.block,history:true,method:'HISTORICAL_REPLAY_CURRENT_OWN_QUOTE'});
 const action=await store.get('SELECT * FROM copy_actions WHERE event_id=?',fixture.provenance.target+':'+s.tx.hash);if(action)await e.processAction(action);
 const saved=action?await store.get('SELECT * FROM copy_actions WHERE id=?',action.id):null;
 results.push({target_hash:s.tx.hash,target_kind:s.expected.kind,side:s.expected.side,token:s.expected.token,state:saved?.state??'TARGET_RECORDED',reason:saved?.error,data:saved?decode(saved.data):null});
 await fs.writeFile(resolve(directory,'replay.json'),JSON.stringify({label:'HISTORICAL_REPLAY_WITH_CURRENT_OWN_MARKET_QUOTES_NOT_LIVE',at:Date.now(),acceptance_passed:false,results},null,2));
 console.log(JSON.stringify({hash:s.tx.hash,kind:s.expected.kind,state:saved?.state,reason:saved?.error,provider:saved?decode(saved.data).quote?.provider:null}));
}
e.rpc=actualRpc;await fs.writeFile(resolve(directory,'summary.json'),JSON.stringify({...await copySummary(store),rpc_telemetry:actualRpc.telemetry.snapshot(actualRpc.providers)},null,2));db.close();
