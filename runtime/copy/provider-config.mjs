import {validateEndpoint} from '../../core/util.mjs';

// Endpoint URLs may contain credentials. Keep them in server memory and mask them
// in summaries; never include them in logs or client configuration.
export function copyEnvironment(env=process.env){
 const hosts=[env.ALLOWED_RPC_HOSTS,'publicnode.com','drpc.org','nodereal.io'].filter(Boolean).join(',');
 const providers=[];
 for(const [role,prefix] of [['primary','BSC_PRIMARY'],['secondary','BSC_SECONDARY'],['archive','BSC_ARCHIVE'],['benchmark','BSC_BENCHMARK']]){
  const http=env[prefix+'_HTTP'],ws=env[prefix+'_WS'];if(!http&&!ws)continue;
  if(!http)throw Error(prefix+'_HTTP_REQUIRED');validateEndpoint(http,hosts);
  if(ws){if(!ws.startsWith('wss:'))throw Error(prefix+'_WSS_REQUIRED');validateEndpoint(ws.replace(/^wss:/,'https:'),hosts);}
  const pending=env[prefix+'_PENDING']??(ws?'STANDARD_FULL':'NONE');if(!['NONE','ALCHEMY_FILTERED','STANDARD_FULL','STANDARD_HASH'].includes(pending))throw Error(prefix+'_PENDING_INVALID');
  const requests_per_second=Number(env[prefix+'_RPS']??8);
  if(!Number.isFinite(requests_per_second)||requests_per_second<1||requests_per_second>1000)throw Error(prefix+'_RPS_INVALID');
  providers.push({id:'env-'+role,label:'BSC '+role,http_url:http,ws_url:ws||null,enabled:true,role,pending,requests_per_second});
 }
 return {providers,keys:{...(env.ZEROX_API_KEY?{zeroEx:env.ZEROX_API_KEY}:{}),...(env.ETHERSCAN_API_KEY?{etherscan:env.ETHERSCAN_API_KEY}:{})}};
}

// Backfill shares the account quota when no separate archive is configured.
// Keep its independent process below two HTTP starts per second.
export function historyReadProviders(providers){
 const archive=providers.filter(p=>p.enabled&&p.role==='archive');
 return (archive.length?archive:providers).map(p=>({...p,role:p.role==='archive'?'primary':p.role,requests_per_second:Math.min(p.requests_per_second??8,2)}));
}
