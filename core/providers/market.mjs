import {http,finite,id,safeError} from '../util.mjs';
import {emit} from '../engine-state.mjs';
const stores=new WeakMap();
function stateFor(store){let state=stores.get(store);if(!state){state={inflight:new Map(),queue:[],timer:null};stores.set(store,state);}return state;}
async function flush(store,state){
 const queued=state.queue.splice(0);state.timer=null;
 const chains=[...new Set(queued.map(item=>item.chain))];
 for(const chain of chains){const items=queued.filter(item=>item.chain===chain);
  // Two-address batches keep response size and latency bounded.
  for(let i=0;i<items.length;i+=2){const batch=items.slice(i,i+2),started=Date.now();
   try{const pairs=await http(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${batch.map(item=>encodeURIComponent(item.address)).join(',')}`);if(!Array.isArray(pairs))throw Error('MALFORMED_MARKET_RESPONSE');
    await Promise.all(batch.map(async item=>{try{const selected=pairs.filter(p=>p.chainId===chain&&(chain==='solana'?p.baseToken?.address===item.address:p.baseToken?.address?.toLowerCase()===item.address.toLowerCase()));item.resolve(await item.provider.persist(store,chain,item.address,selected,started));}catch(e){item.reject(e);}}));
   }catch(e){for(const item of batch)item.reject(e);}
  }
 }
}
export class DexScreenerProvider {
 async discover(store){const previous=store?await store.setting('discovery_cache'):null;if(previous&&Date.now()-previous.at<60000)return previous.items;const v=await http('https://api.dexscreener.com/token-profiles/latest/v1');if(!Array.isArray(v))throw Error('MALFORMED_DISCOVERY');const items=v.filter(x=>['solana','robinhood'].includes(x.chainId)).slice(0,35);if(store)await store.set('discovery_cache',{at:Date.now(),items});return items;}
 async token(chain,address){const data=await http(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);return (data.pairs??[]).filter(p=>p.chainId===chain&&p.baseToken?.address?.toLowerCase()===address.toLowerCase());}
 record(store,chain,address){
  const state=stateFor(store),tokenId=chain+':'+address;if(state.inflight.has(tokenId))return state.inflight.get(tokenId);
  const promise=(async()=>{const recent=await store.get('SELECT received_at,price FROM market_snapshots WHERE token_id=? ORDER BY received_at DESC LIMIT 1',tokenId);if(recent?.price>0&&Date.now()-recent.received_at<5000)return tokenId;
   return new Promise((resolve,reject)=>{state.queue.push({provider:this,chain,address,resolve,reject});if(!state.timer)state.timer=setTimeout(()=>flush(store,state),0);});
  })();state.inflight.set(tokenId,promise);promise.then(()=>state.inflight.delete(tokenId),()=>state.inflight.delete(tokenId));return promise;
 }
 async persist(store,chain,address,pairs,started){if(!pairs.length)throw Error('NO_INDEXED_POOLS');const p=pairs.sort((a,b)=>(b.liquidity?.usd??0)-(a.liquidity?.usd??0))[0];const tokenId=chain+':'+address;const now=Date.now();const prior=await store.get('SELECT id FROM tokens WHERE id=?',tokenId);await store.run('INSERT INTO tokens(id,chain,address,symbol,name,first_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET symbol=excluded.symbol,name=excluded.name',tokenId,chain,address,p.baseToken.symbol??null,p.baseToken.name??null,now);for(const pair of pairs.slice(0,5))await store.run('INSERT INTO pools VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET dex=excluded.dex',chain+':'+pair.pairAddress,tokenId,chain,pair.pairAddress,pair.dexId??null,finite(pair.pairCreatedAt),'DexScreener');
 await store.run('INSERT INTO market_snapshots(token_id,pool_id,observed_at,received_at,price,liquidity,market_cap,fdv,volume_5m,volume_1h,buys_5m,sells_5m,change_5m,change_1h,source,raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',tokenId,chain+':'+p.pairAddress,now,now,finite(p.priceUsd),finite(p.liquidity?.usd),finite(p.marketCap),finite(p.fdv),finite(p.volume?.m5),finite(p.volume?.h1),finite(p.txns?.m5?.buys),finite(p.txns?.m5?.sells),finite(p.priceChange?.m5),finite(p.priceChange?.h1),'DexScreener REST; retrieval timestamp; source event time unavailable',JSON.stringify(p));const cooldown=http.cooldown('https://api.dexscreener.com');const healthStatus=cooldown?(cooldown.reason.includes('429')?'RATE_LIMITED':'BACKOFF'):'CONNECTED';const healthError=cooldown?`PROVIDER_COOLDOWN ${cooldown.provider} · ${cooldown.reason} · retry_in_ms=${Math.ceil(cooldown.until-Date.now())}`:null;await store.run("INSERT INTO provider_health(id,status,latency_ms,last_success,last_attempt,error,requests) VALUES ('market',?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET status=excluded.status,latency_ms=excluded.latency_ms,last_success=excluded.last_success,last_attempt=excluded.last_attempt,error=excluded.error,requests=requests+1",healthStatus,Date.now()-started,now,now,healthError);if(!prior)await emit(store,'TOKEN','Token detectado',{address,symbol:p.baseToken.symbol??null,source:'DexScreener'},chain,tokenId);await emit(store,'MARKET','Mercado actualizado',{address,symbol:p.baseToken.symbol??null,price:finite(p.priceUsd),market_cap:finite(p.marketCap),liquidity:finite(p.liquidity?.usd),volume_5m:finite(p.volume?.m5),buys:finite(p.txns?.m5?.buys),sells:finite(p.txns?.m5?.sells),source:'DexScreener REST',received_at:now,latency_ms:Date.now()-started},chain,tokenId);return tokenId;}
}
export async function recordMarketError(store,e){if(e.message==='NO_INDEXED_POOLS')return;await store.run("INSERT INTO provider_health(id,status,last_attempt,error,requests) VALUES ('market',?,?,?,1) ON CONFLICT(id) DO UPDATE SET status=excluded.status,last_attempt=excluded.last_attempt,error=excluded.error,latency_ms=NULL,requests=requests+1",String(e.message).includes('429')?'RATE_LIMITED':String(e.message).includes('COOLDOWN')?'BACKOFF':'ERROR',Date.now(),safeError(e));}
