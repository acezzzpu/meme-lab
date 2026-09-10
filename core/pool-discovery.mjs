import bs58 from 'bs58';
import {adapter,RH} from './providers/chains.mjs';
import {emit} from './engine-state.mjs';
import {fail} from './util.mjs';

export const SOLANA_POOL_PROGRAMS=[
 {id:'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',dex:'PumpSwap',instructions:[{bytes:[233,146,209,142,207,104,64,188],pool:0,base:3,quote:4}]},
 {id:'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',dex:'Raydium CPMM',instructions:[{bytes:[175,175,109,31,13,152,155,237],pool:3,base:4,quote:5},{bytes:[63,55,254,65,49,178,89,121],pool:4,base:5,quote:6}]}
];
export function decodeSolanaPools(tx){
 if(!tx?.meta||tx.meta.err)return [];
 const keys=tx.transaction?.message?.accountKeys??[];const key=k=>typeof k==='number'?(typeof keys[k]==='string'?keys[k]:keys[k]?.pubkey):typeof k==='string'?k:k?.pubkey;
 const instructions=[...(tx.transaction?.message?.instructions??[]),...(tx.meta.innerInstructions??[]).flatMap(x=>x.instructions??[])];const results=[];
 for(const ix of instructions){const program=SOLANA_POOL_PROGRAMS.find(p=>p.id===key(ix.programId??ix.programIdIndex));if(!program||!ix.data||!ix.accounts)continue;let data;try{data=bs58.decode(ix.data);}catch{continue;}const shape=program.instructions.find(s=>s.bytes.every((v,i)=>data[i]===v));if(!shape)continue;
  const address=key(ix.accounts[shape.pool]),base=key(ix.accounts[shape.base]),quote=key(ix.accounts[shape.quote]);if(address&&base&&quote)results.push({address,base,quote,dex:program.dex,program:program.id});
 }
 return [...new Map(results.map(r=>[r.address,r])).values()];
}
export async function recordPool(store,chain,pool,hash,block,source,raw,createdAt=null){
 const now=Date.now(),eventId=chain+':pool:'+pool.address;const inserted=await store.run('INSERT OR IGNORE INTO chain_events VALUES (?,?,?,?,?,?,?,?,?)',eventId,chain,'POOL_CREATED',hash,String(block),pool.address,now,source,JSON.stringify(raw));
 for(const mint of [pool.base,pool.quote])await store.run('INSERT OR IGNORE INTO tokens(id,chain,address,first_seen) VALUES (?,?,?,?)',chain+':'+mint,chain,mint,now);
 await store.run('INSERT INTO pools VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source',chain+':'+pool.address,chain+':'+pool.base,chain,pool.address,pool.dex,createdAt,source);
 if(inserted.changes)await emit(store,'POOL','Nueva pool confirmada',{...pool,hash,block:String(block),source,created_at:createdAt},chain,pool.address);
 return inserted.changes;
}
export async function inspectSolanaPool(store,hash){const chain=await store.get("SELECT * FROM chains WHERE id='solana'");const tx=await adapter(chain).transaction(hash);fail(tx,'POOL_TRANSACTION_NOT_AVAILABLE');const pools=decodeSolanaPools(tx);for(const pool of pools)await recordPool(store,chain.id,pool,hash,tx.slot,'Solana logsSubscribe + verified instruction',tx,tx.blockTime?tx.blockTime*1000:null);return pools.length;}
export async function inspectEvmPool(store,chainId,log){
 const {Interface}=await import('ethers');fail(log.address.toLowerCase()===RH.factory.toLowerCase()&&!log.removed,'INVALID_POOL_LOG');
 const abi=new Interface(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256)']);const parsed=abi.parseLog(log);fail(parsed?.name==='PairCreated','NOT_PAIR_CREATED');
 const chain=await store.get('SELECT * FROM chains WHERE id=?',chainId);fail(chain.id==='robinhood','FACTORY_MAINNET_ONLY');const receipt=await adapter(chain).receipt(log.transactionHash);fail(receipt?.status==='0x1','POOL_RECEIPT_NOT_CONFIRMED');
 fail(receipt.logs.some(l=>l.address.toLowerCase()===log.address.toLowerCase()&&l.data===log.data&&l.logIndex===log.logIndex),'POOL_LOG_NOT_IN_RECEIPT');
 return recordPool(store,chainId,{address:parsed.args.pair,base:parsed.args.token0,quote:parsed.args.token1,dex:'Uniswap V2'},log.transactionHash,parseInt(log.blockNumber,16),'EVM logs subscription + receipt',receipt);
}
