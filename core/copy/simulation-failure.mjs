import {Interface} from 'ethers';
const errors=new Interface(['error Error(string)','error Panic(uint256)','error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)','error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)','error V2TooLittleReceived()','error V3TooLittleReceived()','error TransactionDeadlinePassed()','error TransferFailed()','error TransferFromFailed()','error ETHTransferFailed()','error ApproveFailed()']);
export function revertBytes(input){
 if(typeof input==='string')return /^0x[0-9a-f]*$/i.test(input)?input:null;
 if(!input||typeof input!=='object')return null;
 for(const k of ['returnData','data','result','originalError','error','cause']){const v=revertBytes(input[k]);if(v&&v!=='0x')return v;}
 return input.returnData==='0x'||input.data==='0x'?'0x':null;
}
export function classifySimulationFailure(input,{stage='SIMULATION',router=null,token=null,route=null}={}){
 const raw=revertBytes(input);let decoded=null;
 if(raw&&raw.length>=10)try{const e=errors.parseError(raw);if(e)decoded={name:e.name,args:Array.from(e.args,x=>typeof x==='bigint'?String(x):x)};}catch{}
 const message=typeof input==='string'?input:input?.message??input?.error?.message??String(input??'UNKNOWN');
 const reason=decoded?.name==='Error'?String(decoded.args[0]):decoded?decoded.name+(decoded.args.length?'('+decoded.args.join(', ')+')':''):message;
 let category='UNKNOWN',basis='No decodable contract reason';
 const rules=[['ROUTE_ERROR',/NO_ATOMIC_BUILDER|PATH_MISMATCH|PATH_DISCONNECTED|SMART_ASSETS|SMART_ADAPTER|NO_.*ROUTE|POOL_NOT_REGISTERED/i],['ALLOWANCE',/allowance|ERC20InsufficientAllowance/i],['BALANCE',/insufficient.*balance|transfer amount exceeds balance|ERC20InsufficientBalance|insufficient funds/i],['DEADLINE',/deadline|expired|TransactionDeadlinePassed/i],['INSUFFICIENT_OUTPUT',/Too little received|TooLittleReceived|INSUFFICIENT_OUTPUT|BELOW_MINIMUM/i],['SLIPPAGE',/slippage/i],['TOKEN_TAX',/explicit.*tax|transfer tax|fee.on.transfer/i],['SIMULATION_ENVIRONMENT',/BUDGET_EXHAUSTED|NO_AVAILABLE_READ_PROVIDER|RPC_HTTP|timeout|method not found|not supported|missing.*inventory|SEED_|SIMULATION_ENVIRONMENT|SIMULATED_NATIVE_PROCEEDS_NOT_VERIFIED|SIMULATION_TOKEN_DEBIT|TARGET_EXIT_FRACTION_UNVERIFIED/i]];
 for(const [c,re] of rules)if(re.test(reason)){category=c;basis=decoded?'Decoded revert':'Explicit diagnostic error';break;}
 if(category==='UNKNOWN'&&/execution reverted|Panic|TransferFailed|TransferFromFailed|ETHTransferFailed|ApproveFailed/.test(reason)){category='ROUTER_REVERT';basis='Router call reverted; underlying cause UNKNOWN';}
 return {category,reason,decoded,raw_revert_data:raw,stage,router,token,route,basis,root_cause:category==='ROUTER_REVERT'?'UNKNOWN':category};
}
