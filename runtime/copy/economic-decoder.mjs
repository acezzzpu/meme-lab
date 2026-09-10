import {BSC,ERC20,TRANSFER,V2_SWAP,V3_SWAP,PANCAKE_V3_SWAP,addr,hex,transferDeltas,sellFraction,cleanError} from '../../core/copy/common.mjs';
import {hasFlapEvent,FLAP_PORTAL} from './flap.mjs';
import {tokenMetadata} from './rpc.mjs';

// Receipt-first economic classification. Router identity never decides whether
// the target exchanged assets. Native block balances are explicitly approximate:
// unrelated internal transfers can also affect an account within the same block.
export async function decodeEconomicTarget(rpc,tx,receipt,block,target,{metadataCache=new Map(),position=null,enrichMetadata=false,historical=false}={}){
 const wallet=addr(target),height=Number(BigInt(receipt.blockNumber)),index=Number(BigInt(receipt.transactionIndex));
 const gas=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice??tx.gasPrice??0);
 const out={hash:tx.hash,from:addr(tx.from),router:tx.to?addr(tx.to):null,block:height,block_hash:receipt.blockHash,tx_index:index,target_at:Number(BigInt(block.timestamp))*1000,gas_raw:String(gas),kind:'UNKNOWN',side:null,token:null,reason:null,decoder:'ECONOMIC_RECEIPT_V1',native_balance_evidence:false,pools:[],candidate_pools:(receipt.logs??[]).filter(l=>[V2_SWAP,V3_SWAP,PANCAKE_V3_SWAP].includes(l.topics?.[0])).map(l=>({address:addr(l.address),topic:l.topics[0]}))};
 if(receipt.status!=='0x1')return {...out,kind:'NON_TRADE',reason:'TARGET_REVERTED'};
 const deltas=transferDeltas(receipt,wallet);out.flows=[...deltas].filter(([,n])=>n!==0n).map(([token,n])=>({token,delta_raw:String(n)}));
 if(out.from!==wallet)return {...out,kind:'TRANSFER',reason:'TARGET_NOT_TRANSACTION_SENDER'};
 const selector=tx.input?.slice(0,10);
 if(selector==='0x095ea7b3')return {...out,kind:'APPROVAL'};
 if(out.router===BSC.wbnb&&['0xd0e30db0','0x2e1a7d4d'].includes(selector))return {...out,kind:'NON_TRADE',reason:'WRAP_UNWRAP'};
 const quotes=new Set([BSC.wbnb,BSC.usdt,BSC.usdc]),assets=[...deltas].filter(([t,n])=>!quotes.has(t)&&n!==0n);
 if(!assets.length)return {...out,kind:out.flows.length||BigInt(tx.value??0)>0n?'TRANSFER':'NON_TRADE',reason:'NO_TARGET_TOKEN_EXCHANGE'};
 if(assets.length!==1)return {...out,reason:'MULTI_ASSET_TRANSACTION',assets:assets.map(([token,n])=>({token,delta_raw:String(n)}))};
 const [token,delta]=assets[0],amount=delta>0n?delta:-delta;Object.assign(out,{token,quantity_raw:String(amount),decimals:null,symbol:token.slice(0,8)});
 const metadataTask=!enrichMetadata?Promise.resolve(metadataCache.get(token)??{}):metadataCache.has(token)?Promise.resolve(metadataCache.get(token)):tokenMetadata(rpc,token).then(m=>{metadataCache.set(token,m);return m;}).catch(e=>({metadata_error:cleanError(e)}));
 const quoteFlows=[...deltas].filter(([t,n])=>quotes.has(t)&&((delta>0n&&n<0n)||(delta<0n&&n>0n)));
 if(quoteFlows.length>1){Object.assign(out,await metadataTask);return {...out,reason:'MULTIPLE_QUOTE_ASSETS'};}
 if(quoteFlows.length){const [q,n]=quoteFlows[0];Object.assign(out,{quote_token:q,quote_raw:String(n<0n?-n:n),quote_evidence_method:'TARGET_ERC20_NET_DELTAS'});}
 else if(delta>0n&&BigInt(tx.value??0)>0n){Object.assign(out,{quote_token:BSC.wbnb,quote_raw:String(BigInt(tx.value)),quote_estimate:'TX_VALUE_UPPER_BOUND_REFUNDS_AND_ROUTER_FEES_UNRESOLVED',quote_evidence_method:'NATIVE_TX_VALUE_AND_TARGET_TOKEN_CREDIT'});}
 else if(delta<0n){
  const withdrawals=(receipt.logs??[]).filter(l=>l.address?.toLowerCase()===BSC.wbnb&&l.topics?.[0]==='0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65');
  if(withdrawals.length===1&&BigInt(withdrawals[0].data)>0n){
   Object.assign(out,{quote_token:BSC.wbnb,quote_raw:String(BigInt(withdrawals[0].data)),quote_estimate:'WBNB_WITHDRAWAL_GROSS_ROUTER_FEES_AND_FINAL_RECIPIENT_UNRESOLVED',quote_evidence_method:'TARGET_TOKEN_DEBIT_AND_SINGLE_WBNB_UNWRAP',native_unwrap_recipient:'0x'+withdrawals[0].topics[1].slice(-40),economic_confidence:'CALL_LEVEL_ESTIMATE_REQUIRES_NATIVE_ATTRIBUTION_FOR_EXACT_PRICE'});
  }else{
  try{
   const [before,after]=await Promise.all([rpc.call('eth_getBalance',[wallet,hex(height-1)]),rpc.call('eth_getBalance',[wallet,hex(height)])]);
   const native=BigInt(after)-BigInt(before)+gas;
   const related=block.transactions?.filter(t=>typeof t==='object'&&(t.from?.toLowerCase()===wallet||t.to?.toLowerCase()===wallet));
   if(related?.length>1)out.quote_evidence_error='MULTIPLE_TARGET_TRANSACTIONS_IN_BLOCK';
   else if(native>0n)Object.assign(out,{quote_token:BSC.wbnb,quote_raw:String(native),quote_estimate:'BLOCK_BALANCE_DELTA_MAY_INCLUDE_OTHER_INTERNAL_TRANSFERS',quote_evidence_method:'NATIVE_BLOCK_BALANCE_DELTA_PLUS_TX_GAS',native_before_raw:String(BigInt(before)),native_after_raw:String(BigInt(after))});
   else out.quote_evidence_error='NO_POSITIVE_NATIVE_NET_DELTA';
  }catch(e){out.quote_evidence_error=cleanError(e);}
  }
 }
 Object.assign(out,await metadataTask);
 if(!out.quote_raw)return {...out,reason:delta<0n?'NATIVE_SELL_PROCEEDS_UNAVAILABLE':'NO_OPPOSING_QUOTE_FLOW'};
 if(hasFlapEvent(receipt))out.pools=[{address:FLAP_PORTAL,adapter:'FLAP_PORTAL'}];
 out.side=delta>0n?'BUY':'SELL';out.kind=out.side;
 if(Number.isInteger(out.decimals))out.price_quote=Number(out.quote_raw)/1e18/(Number(amount)/10**out.decimals);
 if(delta<0n){
  try{
   const [[balance],logs]=await Promise.all([rpc.contract(token,ERC20,'balanceOf',[wallet],hex(historical?height-1:height)),rpc.call('eth_getLogs',[{address:token,fromBlock:hex(height),toBlock:hex(height),topics:[TRANSFER]}])]);
   let before=BigInt(balance);
   for(const log of logs){const li=Number(BigInt(log.transactionIndex));if(historical?li>=index:li<index)continue;const parsed=ERC20.parseLog(log),direction=historical?1n:-1n;if(addr(parsed.args.to)===wallet)before+=direction*parsed.args.value;if(addr(parsed.args.from)===wallet)before-=direction*parsed.args.value;}
   out.target_balance_before=String(before);out.sold_fraction=sellFraction(before,amount);out.exit_evidence=historical?'PRIOR_BLOCK_BALANCE_PLUS_PRECEDING_TRANSFERS':'CURRENT_RECEIPT_BLOCK_BALANCE_MINUS_CURRENT_AND_SUBSEQUENT_TRANSFERS';out.kind=amount===before?'SELL':'PARTIAL_SELL';out.full_exit=amount===before;
  }catch(e){out.exit_evidence='TARGET_BALANCE_BEFORE_UNAVAILABLE';out.exit_evidence_error=cleanError(e);}
 }else if(position?.closed_at)out.kind='REENTRY';
 return out;
}
