import {adapter,USDC,RH} from './providers/chains.mjs';
import {DexScreenerProvider} from './providers/market.mjs';
import {solanaFlows} from './traders.mjs';
import {emit,enqueue} from './engine-state.mjs';
import {digest,http,json,fail} from './util.mjs';

export async function pollWallet(store,walletId){
 const wallet=await store.get('SELECT * FROM wallets WHERE id=?',walletId),watch=await store.get('SELECT * FROM watched_wallets WHERE wallet_id=?',walletId);if(!wallet||!watch?.enabled)return;
 const chain=await store.get('SELECT * FROM chains WHERE id=?',wallet.chain);if(!chain?.enabled)return;
 let hashes=[],before=null,more=false;
 if(chain.family==='solana'){
  const page=await adapter(chain).rpc('getSignaturesForAddress',[wallet.address,{commitment:'confirmed',limit:25,...(watch.head?{until:watch.head}:{}),...(watch.catchup_before?{before:watch.catchup_before}:{})}]);
  hashes=page.map(s=>s.signature);more=page.length===25;before=page.at(-1)?.signature??null;
 }else{
  fail(['robinhood','robinhood-testnet'].includes(chain.id),'WATCH_INDEXER_NOT_CONFIGURED');
  const base=chain.id==='robinhood'?'https://robinhoodchain.blockscout.com':'https://explorer.testnet.chain.robinhood.com';
  const page=await http(base+'/api/v2/addresses/'+wallet.address+'/transactions'+(watch.catchup_before?'?'+new URLSearchParams(json(watch.catchup_before,{})):''));
  const items=page.items??[];const end=items.findIndex(t=>t.hash===watch.head);hashes=(end<0?items:items.slice(0,end)).map(t=>t.hash);more=end<0&&!!page.next_page_params;before=more?JSON.stringify(page.next_page_params):null;
 }
 for(const hash of [...hashes].reverse())await enqueue(store,'wallet:'+wallet.id+':'+hash,'WALLET_TX',{wallet_id:wallet.id,hash});
 const head=watch.catchup_head??hashes[0]??watch.head;
 await store.run('UPDATE watched_wallets SET head=?,catchup_before=?,catchup_head=?,last_sync=?,error=NULL WHERE wallet_id=?',more?watch.head:head,more?before:null,more?head:null,Date.now(),walletId);
 if(more)await emit(store,'TRADER','Recuperando actividad pendiente del trader',{wallet_id:wallet.id,page_size:hashes.length},chain.id,wallet.id);
 return {new_jobs:hashes.length,more};
}
async function evmFlows(receipt,wallet){
 const {Interface}=await import('ethers');const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);const amounts=new Map();
 for(const log of receipt.logs??[]){try{const p=abi.parseLog(log);if(!p)continue;const from=p.args.from.toLowerCase(),to=p.args.to.toLowerCase(),owner=wallet.toLowerCase();const delta=(to===owner?BigInt(p.args.value):0n)-(from===owner?BigInt(p.args.value):0n);if(delta)amounts.set(log.address.toLowerCase(),(amounts.get(log.address.toLowerCase())??0n)+delta);}catch{}}
 const quote=amounts.get(RH.usdg.toLowerCase())??0n,others=[...amounts].filter(([mint,n])=>mint!==RH.usdg.toLowerCase()&&n!==0n);const simple=quote!==0n&&others.length===1&&quote*others[0][1]<0n;
 return [...amounts].filter(([,n])=>n!==0n).map(([mint,n])=>({token_address:mint,delta_raw:String(n),decimals:null,side:simple&&mint!==RH.usdg.toLowerCase()?(n>0n?'INFERRED_BUY':'INFERRED_SELL'):'TOKEN_FLOW',quote_value:null,quote_currency:simple?'USDG':null}));
}
export async function ingestWalletTransaction(store,walletId,hash){
 const wallet=await store.get('SELECT * FROM wallets WHERE id=?',walletId);if(!wallet)return;
 const chain=await store.get('SELECT * FROM chains WHERE id=?',wallet.chain),a=adapter(chain);
 let raw,flows=[],occurred,block,fee,status;
 if(chain.family==='solana'){
  raw=await a.transaction(hash);fail(raw?.meta,'TRANSACTION_NOT_AVAILABLE_YET');block=String(raw.slot);occurred=raw.blockTime?raw.blockTime*1000:null;fee=String(raw.meta.fee);status=raw.meta.err?'FAILED':'CONFIRMED';if(status==='CONFIRMED')flows=solanaFlows(raw,wallet.address);
 }else{
  const [tx,receipt]=await Promise.all([a.transaction(hash),a.receipt(hash)]);fail(tx&&receipt?.blockNumber,'TRANSACTION_NOT_AVAILABLE_YET');const b=await a.rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);raw={tx,receipt};block=String(parseInt(receipt.blockNumber,16));occurred=b?.timestamp?parseInt(b.timestamp,16)*1000:null;fee=String(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice??'0'));status=receipt.status==='0x1'?'CONFIRMED':'FAILED';if(status==='CONFIRMED')flows=await evmFlows(receipt,wallet.address);
 }
 const old=await store.get('SELECT id FROM transactions WHERE chain=? AND hash=? AND wallet_id=?',chain.id,hash,wallet.id);
 const txId=old?.id??await digest(wallet.id+':'+hash),now=Date.now();
 const statements=[['INSERT OR IGNORE INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?)',[txId,chain.id,hash,wallet.id,block,occurred,now,status,fee,JSON.stringify(raw)]]];
 const existingFlows=old?await store.all('SELECT id,token_address FROM wallet_flows WHERE tx_id=?',txId):[];
 for(const f of flows){f.id=existingFlows.find(x=>x.token_address===f.token_address)?.id??await digest(txId+':'+f.token_address);statements.push(['INSERT OR IGNORE INTO wallet_flows VALUES (?,?,?,?,?,?,?,?,?,?)',[f.id,txId,wallet.id,f.token_address,f.delta_raw,f.decimals,f.side,f.quote_value,f.quote_currency,occurred]]);}
 await store.batch(statements);
 for(const f of flows){
  if(await store.get('SELECT flow_id FROM trader_context WHERE flow_id=?',f.id))continue;
  const tokenId=chain.id+':'+f.token_address;let snapshot=occurred?await store.get('SELECT id,received_at,market_cap,liquidity FROM market_snapshots WHERE token_id=? AND received_at<=? ORDER BY received_at DESC LIMIT 1',tokenId,occurred):null;
  let timing=snapshot&&occurred-snapshot.received_at<=300000?'PRE_TRADE':'UNAVAILABLE';if(timing==='UNAVAILABLE')snapshot=null;
  if(!snapshot){try{await new DexScreenerProvider().record(store,chain.id,f.token_address);snapshot=await store.get('SELECT id,received_at,market_cap,liquidity FROM market_snapshots WHERE token_id=? ORDER BY received_at DESC LIMIT 1',tokenId);timing='POST_TRADE_OBSERVATION';}catch{}}
  await store.run('INSERT OR IGNORE INTO trader_context VALUES (?,?,?,?,?)',f.id,tokenId,snapshot?.id??null,timing,Date.now());
  await emit(store,'WALLET',`${wallet.label||wallet.address.slice(0,8)} · ${f.side}`,{wallet_id:wallet.id,hash,block,token_address:f.token_address,side:f.side,delta_raw:f.delta_raw,market_cap:snapshot?.market_cap??null,liquidity:snapshot?.liquidity??null,context_timing:timing,occurred_at:occurred,provider:new URL(chain.rpc_url).hostname},chain.id,f.id);
 }
 if(!old)await emit(store,'WALLET_TX','Transacción del trader registrada',{wallet_id:wallet.id,hash,block,status,flows:flows.length,occurred_at:occurred},chain.id,txId);
 await store.run('UPDATE watched_wallets SET last_event=?,error=NULL WHERE wallet_id=?',Date.now(),walletId);
 await store.run("UPDATE wallets SET status='WATCHING' WHERE id=?",walletId);
 return {hash,new_transaction:!old,flows:flows.length};
}
export async function updateWatchedPatterns(store){
 const wallets=await store.all('SELECT w.* FROM wallets w JOIN watched_wallets v ON v.wallet_id=w.id WHERE v.enabled=1');
 for(const wallet of wallets){
  const rows=await store.all("SELECT m.liquidity,m.market_cap,m.volume_5m FROM wallet_flows f JOIN trader_context c ON c.flow_id=f.id JOIN market_snapshots m ON m.id=c.snapshot_id WHERE f.wallet_id=? AND f.side='INFERRED_BUY' AND c.timing='PRE_TRADE' ORDER BY f.occurred_at",wallet.id);
  const median=key=>{const v=rows.map(r=>r[key]).filter(v=>v!==null).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:null;};
  const old=await store.get('SELECT sample_size FROM patterns WHERE id=?','watch:'+wallet.id);if(old?.sample_size===rows.length)continue;
  const result={type:'DESCRIPTIVE_ONLY',median_entry_liquidity:median('liquidity'),median_entry_market_cap:median('market_cap'),median_entry_volume_5m:median('volume_5m'),pretrade_samples:rows.length,validated_edge:false};
  await store.run('INSERT INTO patterns VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,sample_size=excluded.sample_size,result=excluded.result,status=excluded.status','watch:'+wallet.id,Date.now(),wallet.id,'continuous_entry_context',rows.length,JSON.stringify(result),rows.length<30?'INSUFFICIENT_DATA':'OBSERVATION');
  await emit(store,'LEARNING','Dataset y perfil del trader actualizados',{wallet_id:wallet.id,...result},wallet.chain,wallet.id);
 }
}
