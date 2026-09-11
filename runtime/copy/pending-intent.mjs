import {customPending} from './custom-pending.mjs';
import {calculateSize} from '../../core/copy/execution-policy.mjs';
import {decode,ERC20} from '../../core/copy/common.mjs';
import {Interface} from 'ethers';
import {BSC,addr,encode} from '../../core/copy/common.mjs';
const swaps=new Interface([
 'function swapExactETHForTokens(uint256,address[],address,uint256) payable',
 'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable',
 'function swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
 'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
 'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
 'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)'
]);
export function pendingIntent(tx,target){
 const intent={chain_id:56,target_hash:tx.hash,target:addr(target),status:'PROVISIONAL',side:null,token:null,reason:'PENDING_CALLDATA_UNSUPPORTED',source:'MEMPOOL',confirmed:false};
 if(addr(tx.from)!==addr(target))return null;
 // Pending calldata is intent, never proof that a swap succeeded.
 try{const custom=customPending(tx,target);if(custom)return {...intent,...custom};const p=swaps.parseTransaction({data:tx.input??tx.data,value:tx.value??0});const nativeBuy=p.name.startsWith('swapExactETH');const path=p.args[nativeBuy?1:2].map(addr),recipient=addr(p.args[nativeBuy?2:3]);
  if(recipient!==addr(target))return {...intent,reason:'PENDING_RECIPIENT_IS_NOT_TARGET'};
  if(path[0]===BSC.wbnb)Object.assign(intent,{side:'BUY',token:path.at(-1),target_input_raw:String(nativeBuy?BigInt(tx.value):p.args[0]),reason:null});
  else if(path.at(-1)===BSC.wbnb)Object.assign(intent,{side:'SELL',token:path[0],target_input_raw:String(p.args[0]),reason:null});
 }catch{/* Unsupported custom calldata remains a persisted provisional intent. */}
 return intent;
}
export async function observePending(e,o){
 const tx=o.event,target=e.targets.find(t=>tx.from&&addr(tx.from)===t.address);if(!target)return;
 const mono=o.received_mono??performance.now(),wall=o.received_at??Date.now();e.eventClocks??=new Map();
 if(!e.eventClocks.has(tx.hash))e.eventClocks.set(tx.hash,{boot:e.boot,mono,wall,source:'MEMPOOL'});
 const intent=pendingIntent(tx,target.address);intent.created_at=Date.now();intent.provisional_decode_done_at=Date.now();intent.pending_received_at=wall;intent.pending_received_mono=mono;intent.clock_boot=e.boot;intent.provisional_decode_ms=performance.now()-mono;
 await e.store.run("INSERT INTO copy_source_transactions(chain_id,hash,status,first_seen_at,last_seen_at,data) VALUES (56,?,'PENDING',?,?,?) ON CONFLICT(chain_id,hash) DO UPDATE SET last_seen_at=excluded.last_seen_at",tx.hash,wall,Date.now(),encode({tx,source:'MEMPOOL',provider:o.provider}));
 const inserted=await e.store.run("INSERT OR IGNORE INTO copy_intents(chain_id,hash,target_id,status,data,created_at) VALUES (56,?,?,'PROVISIONAL',?,?)",tx.hash,target.id,encode(intent),intent.created_at);
 if(!inserted.changes)return;
 if(intent.side&&decode(target.config).mode==='PAPER'){prefetchPaper(e,target,intent).catch(()=>{});}
 await e.sample('MEMPOOL_DETECTION_MS',performance.now()-mono,null,o.provider,{hash:tx.hash,clock:'MONOTONIC_LOCAL',meaning:'Receipt of provider message through target filter and durable provisional intent; network propagation unknown'});
 await e.report('PENDING','Target observado; intención provisional guardada',{hash:tx.hash,side:intent.side,token:intent.token,reason:intent.reason,provider:o.provider});
}

async function prefetchPaper(e,target,intent){
 const c=await e.store.setting('copy_config');if(!c.enabled||c.paused||await e.store.setting('engine_desired')!=='RUNNING')return;
 const tc=decode(target.config),event={hash:intent.target_hash,side:intent.side,token:intent.token,quote_token:BSC.wbnb,quote_raw:intent.target_input_raw,quantity_raw:intent.target_input_raw};
 if(event.side==='SELL'){const [balance]=await e.rpc.contract(event.token,ERC20,'balanceOf',[target.address]);event.target_balance_before=String(balance);}
 const amount=await calculateSize(e.store,'PAPER',tc,target.id,event,c,tc.size_mode==='FIXED_USD'?await e.freshPrice():null);if(amount<=0n)return;
 e.pendingQuotes??=new Map();const started=Date.now();
 const promise=e.routes.quote({side:event.side,token:event.token,amount:String(amount),slippageBps:c.max_slippage_bps,paper:true,candidatePools:intent.candidate_pools??[],taker:'0x000000000000000000000000000000000000dead'},{allowUnknownImpact:true,priority:2,deadlineAt:started+4000});promise.catch(()=>{});
 e.pendingQuotes.set(intent.target_hash,{amount:String(amount),promise,started_at:started});if(e.pendingQuotes.size>300)e.pendingQuotes.delete(e.pendingQuotes.keys().next().value);
 await e.store.run("UPDATE copy_intents SET data=json_set(data,'$.copy_amount_raw',?,'$.quotes_started_at',?) WHERE chain_id=56 AND hash=? AND target_id=?",String(amount),started,intent.target_hash,target.id);
 try{const q=await promise;await e.store.run("UPDATE copy_intents SET data=json_set(data,'$.first_quote_at',?,'$.provisional_quote',json(?)) WHERE chain_id=56 AND hash=? AND target_id=?",Date.now(),encode(q),intent.target_hash,target.id);}catch{/* Canonical processing independently retries with fresh routes. */}
}
