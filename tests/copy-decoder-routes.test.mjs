import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {decodeTarget} from '../runtime/copy/decoder.mjs';
import {PancakeV2Route} from '../runtime/copy/routes.mjs';
import {BSC,ERC20} from '../core/copy/common.mjs';
const {Interface}=createRequire(new URL('../package.json',import.meta.url))('ethers');

// Offline regression fixtures: no network, keys, signer, database or broadcasts.
const TARGET='0x1111111111111111111111111111111111111111';
const TOKEN='0x2222222222222222222222222222222222222222';
const POOL='0x3333333333333333333333333333333333333333';
const OTHER='0x4444444444444444444444444444444444444444';
const BRIDGE='0x5555555555555555555555555555555555555555';
const HASH='0x'+'aa'.repeat(32),BLOCK_HASH='0x'+'bb'.repeat(32);
const E18=10n**18n;
const V2=new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);

function transfer(address,from,to,value,index){return {address,...ERC20.encodeEventLog(ERC20.getEvent('Transfer'),[from,to,value]),transactionIndex:'0x0',logIndex:'0x'+index.toString(16)};}
function fixture({native=false,factory=BSC.factory,registered=POOL,trace=null}={}){
 const tx={from:TARGET,to:OTHER,hash:HASH,input:'0xabcd1234',value:native?'0x'+E18.toString(16):'0x0'};
 const logs=[transfer(TOKEN,POOL,TARGET,100n*E18,0)];
 if(!native)logs.push(transfer(BSC.usdt,TARGET,POOL,600n*E18,1));
 logs.push({address:POOL,...V2.encodeEventLog(V2.getEvent('Swap'),[OTHER,0n,native?E18:600n*E18,100n*E18,0n,TARGET]),transactionIndex:'0x0',logIndex:'0x2'});
 const receipt={blockNumber:'0x10',blockHash:BLOCK_HASH,transactionIndex:'0x0',transactionHash:HASH,gasUsed:'0x0',effectiveGasPrice:'0x0',status:'0x1',logs};
 const block={number:'0x10',hash:BLOCK_HASH,timestamp:'0x10',transactions:[tx,{from:OTHER,to:BRIDGE,hash:'0x'+'cc'.repeat(32),value:'0x0'}]};
 const calls=[];
 const rpc={
  contract:async(address,abi,method,args=[])=>{
   calls.push({method,address,args});
   if(method==='token0')return [TOKEN];
   if(method==='token1')return [native?BSC.wbnb:BSC.usdt];
   if(method==='factory')return [factory];
   if(method==='getPair')return [registered];
   if(method==='decimals')return [18n];
   if(method==='symbol')return ['TEST'];
   throw Error('UNEXPECTED_CONTRACT_METHOD '+method);
  },
  call:async(method,args=[])=>{
   calls.push({method,args});
   if(method==='eth_getBlockByNumber')return block;
   // The block also includes an INTERNAL 0.5 BNB receipt from another tx.
   // The top-level block transactions do not expose that movement.
   if(method==='eth_getBalance')return args[1]==='0xf'?'0x'+(10n*E18).toString(16):'0x'+(95n*E18/10n).toString(16);
   if(method==='debug_traceTransaction'){
    assert.equal(args[0],HASH);
    if(!trace)throw Error('TRACE_NOT_SUPPORTED');
    return trace;
   }
   throw Error('UNEXPECTED_RPC_METHOD '+method);
  }
 };
 return {rpc,tx,receipt,block,calls};
}

test('control: registered Pancake V2 pool and USDT debit produce a BUY',async()=>{
 const f=fixture();
 const result=await decodeTarget(f.rpc,f.tx,f.receipt,f.block,TARGET);
 assert.equal(result.side,'BUY');
 assert.equal(result.quote_token,BSC.usdt);
 assert.equal(result.quote_raw,(600n*E18).toString());
 assert.equal(result.quantity_raw,(100n*E18).toString());
});

test('reject an arbitrary factory even when its pool declares the traded token',async()=>{
 const f=fixture({factory:OTHER});
 const result=await decodeTarget(f.rpc,f.tx,f.receipt,f.block,TARGET);
 assert.ok(!result.side,'Self-reported factory and Swap topic must not authorize a copy action');
});

test('reject a pool claiming official factory but not registered by getPair',async()=>{
 const f=fixture({registered:OTHER});
 const result=await decodeTarget(f.rpc,f.tx,f.receipt,f.block,TARGET);
 assert.ok(!result.side,'The official factory must map token pair to the actual log emitter');
});

test('native block balance contaminated by another internal transfer is not exact evidence',async()=>{
 const f=fixture({native:true});
 const result=await decodeTarget(f.rpc,f.tx,f.receipt,f.block,TARGET);
 assert.notEqual(result.native_balance_evidence,true,'Block-level balances cannot isolate native proceeds of one transaction');
 assert.ok(!result.side||result.quote_estimate,'Missing tx-specific trace must remain non-executable as exact LIVE price');
 if(result.side)assert.equal(result.quote_raw,E18.toString(),'tx.value can only be retained as an explicitly labeled upper bound');
});

test('a trace isolates target debit and refund without including other block transactions',async()=>{
 const trace={type:'CALL',from:TARGET,to:OTHER,value:'0x'+E18.toString(16),calls:[
  {type:'CALL',from:OTHER,to:TARGET,value:'0x'+(E18/10n).toString(16)},
  // Failed nested calls and DELEGATECALL value fields must not create transfers.
  {type:'CALL',from:OTHER,to:TARGET,value:'0x'+(E18/2n).toString(16),error:'execution reverted'},
  {type:'DELEGATECALL',from:OTHER,to:TARGET,value:'0x'+E18.toString(16)}
 ]};
 const f=fixture({native:true,trace});
 const result=await decodeTarget(f.rpc,f.tx,f.receipt,f.block,TARGET);
 assert.equal(result.side,'BUY');
 assert.equal(result.quote_raw,(9n*E18/10n).toString(),'Exact tx debit is 1 BNB minus a 0.1 BNB refund');
 assert.ok(!result.quote_estimate,'Successful complete call trace can establish tx-specific native transfer');
 assert.ok(f.calls.some(x=>x.method==='debug_traceTransaction'));
});

test('multihop token liquidity must not inherit the deep WBNB bridge liquidity',async()=>{
 const rpc={
  verify:async()=>{},
  call:async method=>{if(method==='eth_gasPrice')return '0x1';if(method==='eth_blockNumber')return '0x10';throw Error('Unexpected RPC '+method);},
  contract:async(address,abi,method,args=[])=>{
   if(method==='WETH')return [BSC.wbnb];
   if(method==='factory')return [BSC.factory];
   if(method==='getPair')return [args.includes(TOKEN)?POOL:BRIDGE];
   if(method==='token0')return [address===BRIDGE?BSC.wbnb:BSC.usdt];
   if(method==='token1')return [address===BRIDGE?BSC.usdt:TOKEN];
   if(method==='getReserves')return address===BRIDGE?[1000n*E18,600000n*E18,0n]:[E18,1000n*E18,0n];
   if(method==='getAmountsOut'){
    const [input,path]=args;
    if(path.length===2&&path.includes(TOKEN))throw Error('NO_DIRECT_POOL');
    if(path.length===2)return [[input,input*600n]];
    return [[input,input*600n,input*600000n*995n/1000n]];
   }
   throw Error('Unexpected contract '+method);
  }
 };
 const result=await new PancakeV2Route(rpc).quote({side:'BUY',token:TOKEN,amount:10n**9n,slippageBps:100,taker:TARGET});
 assert.deepEqual(result.route,[BSC.wbnb,BSC.usdt,TOKEN]);
 // Token pool has only 1 USDT quote reserve: about $2 total, BNB ~$600.
 // Unknown is acceptable if cross-currency depth cannot be verified.
 assert.ok(result.liquidity_bnb===null||result.liquidity_bnb<=2/600*1.01,
  'A ~$2 token pool must not report the bridge pool\'s 2,000 BNB liquidity');
});
