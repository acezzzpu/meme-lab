import bs58 from 'bs58';
import {SOL,USDC} from '../providers/chains.mjs';

// Official pump-public-docs/idl/pump_amm.json. Unknown routes remain observations.
export const PUMP_AMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const instructions=new Map([
 ['102,6,61,18,1,218,235,234','BUY'],['198,46,21,82,180,217,232,112','BUY'],['51,230,133,164,1,127,131,173','SELL'],
]);
export function verifiedWalletSwaps(tx,wallet) {
  if(!tx?.meta||tx.meta.err!==null||!tx.transaction?.message)return [];
  const message=tx.transaction.message;
  const keys=(message.accountKeys??message.staticAccountKeys??[]).map(k=>typeof k==='string'?k:k.pubkey);
  if(typeof (message.accountKeys??message.staticAccountKeys)?.[0]==='string')keys.push(...(tx.meta.loadedAddresses?.writable??[]),...(tx.meta.loadedAddresses?.readonly??[]));
  const account=a=>typeof a==='number'?keys[a]:a;
  // Direct invocations only: a successful outer transaction can contain caught
  // failed CPIs. Supporting aggregator routes needs invocation-scoped decoding.
  const all=message.instructions??message.compiledInstructions??[];
  const matches=[];let swapCount=0;
  for(const instruction of all){
    const program=instruction.programId??keys[instruction.programIdIndex];if(program!==PUMP_AMM)continue;
    let data;try{data=typeof instruction.data==='string'?bs58.decode(instruction.data):Uint8Array.from(instruction.data??[]);}catch{continue;}
    const side=instructions.get([...data.slice(0,8)].join(','));if(!side)continue;
    const a=(instruction.accounts??instruction.accountKeyIndexes??[]).map(account);
    if(a[1]!==wallet||!a[3]||![SOL,USDC].includes(a[4])||[SOL,USDC].includes(a[3]))continue;
    swapCount++;
    if(side==='BUY'?(data.length!==25||data[24]>1):data.length!==24)continue;
    if([...data.slice(8,16)].every(x=>x===0))continue;
    if(!(tx.meta.logMessages??[]).includes('Program '+PUMP_AMM+' success'))continue;
    const before=(tx.meta.preTokenBalances??[]).find(b=>keys[b.accountIndex]===a[5]);
    const after=(tx.meta.postTokenBalances??[]).find(b=>keys[b.accountIndex]===a[5]);
    if(!before&&!after)continue;
    if([before,after].filter(Boolean).some(b=>b.owner!==wallet||b.mint!==a[3]||!/^\d+$/.test(b.uiTokenAmount?.amount??'')||!Number.isInteger(b.uiTokenAmount?.decimals)))continue;
    if(before&&after&&before.uiTokenAmount.decimals!==after.uiTokenAmount.decimals)continue;
    const delta=BigInt(after?.uiTokenAmount.amount??'0')-BigInt(before?.uiTokenAmount.amount??'0');
    if(side==='BUY'?delta<=0n:delta>=0n)continue;
    matches.push({token_address:a[3],side:'INFERRED_'+side,delta_raw:String(delta),decimals:(after??before).uiTokenAmount.decimals,
      quote_currency:a[4]===SOL?'WSOL':'USDC',quote_value:null,program:PUMP_AMM,base_account:a[5],method:'PUMPSWAP_INSTRUCTION_AND_BALANCE_V1'});
  }
  // Multiple swaps, round trips or aggregated directions require a route decoder.
  return swapCount===1&&matches.length===1?matches:[];
}
