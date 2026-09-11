import {validateEndpoint} from '../../core/util.mjs';

// Endpoint URLs may contain credentials. Keep them in server memory and mask them
// in summaries; never include them in logs or client configuration.
export function copyEnvironment(env=process.env){
 if(env.BSC_FREE_BASELINE==='1')return {providers:freeBscProviders(),keys:{},freeBaseline:true};
 const hosts=[env.ALLOWED_RPC_HOSTS,'publicnode.com','drpc.org','nodereal.io'].filter(Boolean).join(',');
 const providers=[];
 for(const [role,prefix] of [['primary','BSC_PRIMARY'],['secondary','BSC_SECONDARY'],['archive','BSC_ARCHIVE'],['benchmark','BSC_BENCHMARK']]){
  const http=env[prefix+'_HTTP'],ws=env[prefix+'_WS'];if(!http&&!ws)continue;
  if(!http)throw Error(prefix+'_HTTP_REQUIRED');validateEndpoint(http,hosts);
  if(ws){if(!ws.startsWith('wss:'))throw Error(prefix+'_WSS_REQUIRED');validateEndpoint(ws.replace(/^wss:/,'https:'),hosts);}
  const pending=env[prefix+'_PENDING']??(ws?'STANDARD_FULL':'NONE');if(!['NONE','ALCHEMY_FILTERED','STANDARD_FULL','STANDARD_HASH'].includes(pending))throw Error(prefix+'_PENDING_INVALID');
  const requests_per_second=Number(env[prefix+'_RPS']??8);
  if(!Number.isFinite(requests_per_second)||requests_per_second<1||requests_per_second>1000)throw Error(prefix+'_RPS_INVALID');
  const metered=/quiknode\.pro|nodereal\.io|drpc\.(org|live)/.test(new URL(http).hostname);
  const daily_credit_limit=env[prefix+'_DAILY_CREDITS']?Number(env[prefix+'_DAILY_CREDITS']):null;
  if(daily_credit_limit!==null&&(!Number.isFinite(daily_credit_limit)||daily_credit_limit<=0))throw Error(prefix+'_DAILY_CREDITS_INVALID');
  providers.push({id:'env-'+role,label:'BSC '+role,http_url:http,ws_url:ws||null,enabled:true,role,pending,requests_per_second,history_dedicated:role==='archive'&&env.BSC_ARCHIVE_SEPARATE_QUOTA==='1',daily_credit_limit,credit_unit:http.includes('quiknode.pro')?20:0,pending_budget_allowed:!metered||env[prefix+'_ALLOW_UNFILTERED_PENDING']==='1',hash_lookups_per_minute:0});
 }
 return {providers,keys:{...(env.ZEROX_API_KEY?{zeroEx:env.ZEROX_API_KEY}:{}),...(env.ETHERSCAN_API_KEY?{etherscan:env.ETHERSCAN_API_KEY}:{})}};
}

// Backfill shares the account quota when no separate archive is configured.
// Keep its independent process below two HTTP starts per second.
export function historyReadProviders(providers){
 const live=providers.filter(p=>p.enabled&&!['archive','benchmark'].includes(p.role));
 const archive=providers.filter(p=>p.enabled&&p.role==='archive'&&p.history_dedicated===true&&!live.some(a=>a.http_url===p.http_url));
 return archive.map(p=>({...p,role:'primary',requests_per_second:Math.min(p.requests_per_second??1,0.5)}));
}

export function freeBscProviders(){return [
 {id:'free-publicnode',label:'PublicNode BSC',role:'primary',http_url:'https://bsc-rpc.publicnode.com',ws_url:'wss://bsc-rpc.publicnode.com',pending:'STANDARD_FULL',pending_budget_allowed:true},
 {id:'free-drpc',label:'dRPC public BSC',role:'secondary',http_url:'https://bsc.drpc.org',ws_url:'wss://bsc.drpc.org',pending:'NONE'},
 {id:'free-bnb',label:'BNB official public RPC',role:'fallback',http_url:'https://bsc-dataseed.bnbchain.org',ws_url:null,pending:'NONE'},
 ].map(p=>({...p,enabled:true,requests_per_second:8,credit_unit:0,hash_lookups_per_minute:0,history_dedicated:false,public_free:true}));}
