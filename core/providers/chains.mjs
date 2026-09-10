import {rpc,fail,safeError} from '../util.mjs';
export const SOL='So11111111111111111111111111111111111111112';
export const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const RH={factory:'0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',router:'0x89e5DB8B5aA49aA85AC63f691524311AEB649eba',weth:'0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',usdg:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'};
export const explorers={solana:'https://solscan.io/tx/',robinhood:'https://robinhoodchain.blockscout.com/tx/','robinhood-testnet':'https://explorer.testnet.chain.robinhood.com/tx/'};
export class SolanaAdapter {
 constructor(chain){this.chain=chain;}
 rpc(method,params=[]){return rpc(this.chain.rpc_url,method,params);}
 async health(){const [genesis,slot]=await Promise.all([this.rpc('getGenesisHash'),this.rpc('getSlot',[{commitment:'confirmed'}])]);const expected=this.chain.id==='solana'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';fail(genesis===expected,'CHAIN_GENESIS_MISMATCH');return {block:String(slot),genesis};}
 async token(mint){const info=await this.rpc('getAccountInfo',[mint,{encoding:'jsonParsed',commitment:'confirmed'}]);const v=info?.value;fail(v?.data?.parsed?.type==='mint','NOT_A_TOKEN_MINT');const d=v.data.parsed.info;return {address:mint,decimals:d.decimals,supply_raw:d.supply,mint_authority:d.mintAuthority,freeze_authority:d.freezeAuthority,program:v.owner,extensions:d.extensions??[],slot:info.context.slot};}
 balance(wallet){return this.rpc('getBalance',[wallet,{commitment:'confirmed'}]);}
 async tokenBalances(wallet){const lists=await Promise.all(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].map(programId=>this.rpc('getTokenAccountsByOwner',[wallet,{programId},{encoding:'jsonParsed'}])));return lists.flatMap(x=>x.value);}
 history(wallet,before,limit=15){return this.rpc('getSignaturesForAddress',[wallet,{limit,...(before?{before}:{}),commitment:'confirmed'}]);}
 transaction(hash){return this.rpc('getTransaction',[hash,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);}
 simulate(bytes,wallet=null){return this.rpc('simulateTransaction',[bytes,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'confirmed',...(wallet?{accounts:{encoding:'base64',addresses:[wallet]}}:{})}]);}
}
export class EvmAdapter {
 constructor(chain){this.chain=chain;}
 rpc(method,params=[]){return rpc(this.chain.rpc_url,method,params);}
 async health(){const [chainId,block]=await Promise.all([this.rpc('eth_chainId'),this.rpc('eth_blockNumber')]);fail(parseInt(chainId,16)===this.chain.chain_id,'CHAIN_ID_MISMATCH');return {block:String(parseInt(block,16)),chain_id:parseInt(chainId,16)};}
 async token(address){const {Interface}=await import('ethers');const i=new Interface(['function decimals() view returns(uint8)','function symbol() view returns(string)','function totalSupply() view returns(uint256)']);const [code,decimals,supply]=await Promise.all([this.rpc('eth_getCode',[address,'latest']),this.rpc('eth_call',[{to:address,data:i.encodeFunctionData('decimals')},'latest']),this.rpc('eth_call',[{to:address,data:i.encodeFunctionData('totalSupply')},'latest'])]);fail(code!=='0x','NO_CONTRACT_CODE');let symbol=null;try{symbol=i.decodeFunctionResult('symbol',await this.rpc('eth_call',[{to:address,data:i.encodeFunctionData('symbol')},'latest']))[0];}catch{}return {address,decimals:Number(i.decodeFunctionResult('decimals',decimals)[0]),supply_raw:i.decodeFunctionResult('totalSupply',supply)[0].toString(),symbol,contract_code:true};}
 balance(wallet){return this.rpc('eth_getBalance',[wallet,'latest']);}
 transaction(hash){return this.rpc('eth_getTransactionByHash',[hash]);}
 receipt(hash){return this.rpc('eth_getTransactionReceipt',[hash]);}
}
export const adapter=(chain)=>chain.family==='solana'?new SolanaAdapter(chain):new EvmAdapter(chain);
export async function recordHealthy(store,chain,h,latency){
 const now=Date.now();
 await store.run("INSERT INTO provider_health(id,status,latency_ms,last_success,last_attempt,block,requests) VALUES (?,'CONNECTED',?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET status='CONNECTED',latency_ms=excluded.latency_ms,last_success=excluded.last_success,last_attempt=excluded.last_attempt,block=excluded.block,error=NULL,requests=requests+1",chain.id,latency,now,now,h.block);
 return {...h,status:'CONNECTED'};
}
export async function checkHealth(store,chain){
 const start=Date.now();
 try{return await recordHealthy(store,chain,await adapter(chain).health(),Date.now()-start);}
 catch(e){
  const error=safeError(e),status=error.includes('429')?'RATE_LIMITED':'ERROR';
  await store.run('INSERT INTO provider_health(id,status,last_attempt,error,requests) VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET status=excluded.status,last_attempt=excluded.last_attempt,error=excluded.error,latency_ms=NULL,block=NULL,requests=requests+1',chain.id,status,Date.now(),error);
  return {status,error};
 }
}
