import {addr,check,decode,encode} from '../../core/copy/common.mjs';
import {copyProviders} from '../../core/copy/service.mjs';
export function nativeDeltaFromTrace(trace,wallet){
 check(trace&&!trace.error,'ARCHIVE_TRACE_UNAVAILABLE');let net=0n;const target=addr(wallet);
 function visit(call){if(call.error)return;const n=BigInt(call.value??0);if(n&&['CALL','CREATE','CREATE2','SELFDESTRUCT'].includes(call.type)){if(call.from&&addr(call.from)===target)net-=n;if(call.to&&addr(call.to)===target)net+=n;}for(const child of call.calls??[])visit(child);}
 visit(trace);return net;
}
// Optional archive worker ONLY. Never run this before quote or PAPER fill.
export async function enrichNativeEvent(e,{eventId}){
 check(e.options.historicalOnly,'NATIVE_ENRICHMENT_REQUIRES_SEPARATE_PROCESS');
 const providers=await copyProviders(e.store);check(providers.some(p=>p.enabled&&p.role==='archive'),'SEPARATE_ARCHIVE_RPC_NOT_CONFIGURED');
 const row=await e.store.get('SELECT e.data,t.address FROM copy_events e JOIN copy_targets t ON t.id=e.target_id WHERE e.id=?',eventId);if(!row)return;
 const event=decode(row.data);if(!event.quote_estimate||!event.side)return;
 const trace=await e.rpc.call('debug_traceTransaction',[event.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false}}]),net=nativeDeltaFromTrace(trace,row.address);
 check(event.side==='BUY'?net<0n:net>0n,'ARCHIVE_NATIVE_SIDE_MISMATCH');const exact=String(net<0n?-net:net);
 const updated={...event,initial_quote_raw:event.quote_raw,initial_quote_estimate:event.quote_estimate,quote_raw:exact,quote_estimate:null,quote_evidence_method:'OPTIONAL_ARCHIVE_TRACE_NET_TARGET_NATIVE',native_balance_evidence:true,native_enriched_at:Date.now()};
 updated.price_quote=Number.isInteger(event.decimals)?Number(exact)/1e18/(Number(event.quantity_raw)/10**event.decimals):null;
 await e.store.run('UPDATE copy_events SET data=? WHERE id=? AND status=\'CONFIRMED\'',encode(updated),eventId);
}
