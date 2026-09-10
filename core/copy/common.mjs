import {Interface,parseEther,formatEther,getAddress,id as keccakId} from 'ethers';
export const BSC={chainId:56,smartRouter:'0x13f4ea83d0bd40e75c8222255bc855a974568dd4',quoterV3:'0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',router:'0x10ed43c718714eb63d5aa57b78b54704e256024e',factory:'0xca143ce32fe78f1f7019d7d551a6402fc5350c73',v3factory:'0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',wbnb:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',usdt:'0x55d398326f99059ff775485246999027b3197955',usdc:'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',holder:'0x0000000000001ff3684f28c67538d4d072c22734',native:'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'};
export const ERC20=new Interface(['function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)','function symbol() view returns(string)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
export const ROUTER=new Interface(['function WETH() view returns(address)','function factory() view returns(address)','function getAmountsOut(uint256,address[]) view returns(uint256[])','function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable','function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)','function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)']);
export const PAIR=new Interface(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function fee() view returns(uint24)','function getReserves() view returns(uint112,uint112,uint32)']);
export const FACTORY=new Interface(['function getPair(address,address) view returns(address)']);
export const V3FACTORY=new Interface(['function getPool(address,address,uint24) view returns(address)']);
export const PANCAKE_V3_SWAP=keccakId('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');
export const TRANSFER=keccakId('Transfer(address,address,uint256)');
export const V2_SWAP=keccakId('Swap(address,uint256,uint256,uint256,uint256,address)');
export const V3_SWAP=keccakId('Swap(address,address,int256,int256,uint160,uint128,int24)');
export const addr=v=>getAddress(v).toLowerCase();
export const wei=v=>parseEther(String(v));
export const bnb=v=>formatEther(BigInt(v??0));
export const hex=v=>'0x'+BigInt(v).toString(16);
export const packed=v=>'0x'+addr(v).slice(2).padStart(64,'0');
export const check=(condition,message)=>{if(!condition)throw Error(message);};
export const encode=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
export const decode=(v,fallback={})=>{try{return typeof v==='string'?JSON.parse(v):v??fallback;}catch{return fallback;}};
export const bucket=mode=>mode.startsWith('LIVE')?'LIVE':mode;
export const cleanError=e=>String(e?.message??e).replace(/https?:\/\/[^\s]+/g,'[provider]').replace(/0x[a-fA-F0-9]{64,}/g,'[data]').slice(0,240);
export function quantiles(values){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);const at=p=>a.length?a[Math.max(0,Math.ceil(a.length*p)-1)]:null;return {n:a.length,p50:at(.5),p95:at(.95),p99:at(.99)};}
export function timing(){const wall=Date.now(),mono=performance.now();return ()=>({at:Date.now(),elapsed_ms:performance.now()-mono,origin_at:wall});}
export function transferDeltas(receipt,wallet){const result=new Map();for(const l of receipt.logs??[]){if(l.topics?.[0]?.toLowerCase()!==TRANSFER)continue;try{const v=ERC20.parseLog(l),from=addr(v.args.from),to=addr(v.args.to),token=addr(l.address);let delta=0n;if(to===addr(wallet))delta+=v.args.value;if(from===addr(wallet))delta-=v.args.value;if(delta)result.set(token,(result.get(token)??0n)+delta);}catch{}}return result;}
export function sellFraction(before,sold){before=BigInt(before);sold=BigInt(sold);check(before>0n&&sold>0n&&sold<=before,'TARGET_BALANCE_UNKNOWN');return Number(sold*1000000n/before)/1000000;}
export function mirroredQuantity(ours,before,sold){check(BigInt(before)>0n&&BigInt(sold)<=BigInt(before),'TARGET_BALANCE_UNKNOWN');return BigInt(ours)*BigInt(sold)/BigInt(before);}

export const SMART_ROUTER=new Interface(['function WETH9() view returns(address)','function factory() view returns(address)','function factoryV2() view returns(address)','function multicall(uint256 deadline,bytes[] data) payable returns(bytes[])','function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to) payable returns(uint256)','function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns(uint256)','function unwrapWETH9(uint256 minimum,address recipient) payable','function refundETH() payable']);
export const QUOTER_V3=new Interface(['function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)']);
export const V3POOL=new Interface(['function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)']);
export function v3Path(tokens,fees){check(tokens.length===fees.length+1,'V3_PATH_LENGTH');return '0x'+tokens.map((token,i)=>addr(token).slice(2)+(i<fees.length?Number(fees[i]).toString(16).padStart(6,'0'):'')).join('');}

export function mergePools(...lists){const pools=new Map();for(const list of lists)for(const p of list??[])if(p?.address)pools.set(addr(p.address),p);return [...pools.values()].slice(-40);}
