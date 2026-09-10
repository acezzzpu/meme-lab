import {Interface} from 'ethers';
import {BSC,addr,check} from '../../core/copy/common.mjs';
const ROUTER='0x1de460f363af910f51726def188f9004276bf4bc',ZERO='0x0000000000000000000000000000000000000000';
const abi=new Interface(['function swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],address,uint256,uint256,uint256) payable']);
// Positional layout checked against the 36 real trades in our captured sample.
// This is a provisional interpretation of calldata, not receipt evidence or a
// claim about the source code of this upgradeable router. Never signs/builds it.
export function customPending(tx,target){
 if(tx.to?.toLowerCase()!==ROUTER||(tx.input??tx.data)?.slice(0,10)!=='0x4d819a2a')return null;
 const p=abi.parseTransaction({data:tx.input??tx.data,value:tx.value??0}),hops=p.args[0];check(hops.length>0&&hops.length<=8,'CUSTOM_PENDING_PATH_LENGTH');
 check([ZERO,addr(target)].includes(addr(p.args[1])),'CUSTOM_PENDING_RECIPIENT_UNSUPPORTED');
 for(let i=1;i<hops.length;i++)check(addr(hops[i-1][2])===addr(hops[i][1]),'CUSTOM_PENDING_DISCONNECTED_PATH');
 const input=addr(hops[0][1]),output=addr(hops.at(-1)[2]),native=BigInt(tx.value??0),amount=BigInt(p.args[2]);
 check(amount>0n,'CUSTOM_PENDING_ZERO_AMOUNT');
 const buy=[BSC.wbnb,ZERO].includes(input)&&![BSC.wbnb,ZERO].includes(output),sell=[BSC.wbnb,ZERO].includes(output)&&![BSC.wbnb,ZERO].includes(input);check(buy||sell,'CUSTOM_PENDING_QUOTE_UNSUPPORTED');
 check(buy?native===0n||native>=amount:native===0n,'CUSTOM_PENDING_VALUE_MISMATCH');
 return {side:buy?'BUY':'SELL',token:buy?output:input,target_input_raw:String(buy&&native>0n?native:amount),candidate_pools:hops.map(h=>({address:addr(h[3])})),calldata_evidence:'POSITIONAL_LAYOUT_VALIDATED_AGAINST_36_HISTORICAL_RECEIPTS; PROVISIONAL_UNTIL_CANONICAL',reason:null};
}
