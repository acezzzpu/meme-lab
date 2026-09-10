import WebSocket from 'ws';
import https from 'node:https';
import {SOLANA_POOL_PROGRAMS} from '../core/pool-discovery.mjs';
import {RH,adapter} from '../core/providers/chains.mjs';
import {enqueue,emit} from '../core/engine-state.mjs';
import {safeError,validateEndpoint} from '../core/util.mjs';

export function inferredWebSocket(chain){
 if(chain.ws_url)return chain.ws_url;
 const u=new URL(chain.rpc_url);
 if(chain.family==='solana'&&['api.mainnet-beta.solana.com','api.devnet.solana.com','solana-rpc.publicnode.com'].includes(u.hostname))return chain.rpc_url.replace('https:','wss:');
 if(['helius-rpc.com','alchemy.com','quiknode.pro'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return chain.rpc_url.replace('https:','wss:');
 return null;
}
export class NetworkStream{
 constructor(store,chain,wallets,url,allowedHosts){Object.assign(this,{store,chain,wallets,url,allowedHosts});this.closed=false;this.reconnects=0;this.nextId=0;this.pending=new Map();this.subscriptions=new Map();this.subscriptionErrors=new Map();this.lastPersist=0;this.lastEvent=0;}
 async status(status,error=null,block=null){await this.store.run('INSERT INTO ws_health(chain,status,provider,last_event,last_block,connected_at,reconnects,error,subscription_count) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(chain) DO UPDATE SET status=excluded.status,provider=excluded.provider,last_event=COALESCE(excluded.last_event,ws_health.last_event),last_block=COALESCE(excluded.last_block,ws_health.last_block),connected_at=excluded.connected_at,reconnects=excluded.reconnects,error=excluded.error,subscription_count=excluded.subscription_count',this.chain.id,status,new URL(this.url).hostname,this.lastEvent||null,block,this.connectedAt??null,this.reconnects,error,this.subscriptions.size);}
 async start(){
  if(this.closed)return;
  try{validateEndpoint(this.url.replace('wss:','https:'),this.allowedHosts);if(!this.url.startsWith('wss:'))throw Error('WSS_REQUIRED');await adapter(this.chain).health();if(this.closed)return;
   await this.status('CONNECTING');const ws=this.socket=new WebSocket(this.url,{agent:new https.Agent({proxyEnv:process.env}),handshakeTimeout:12000,maxPayload:4*1024*1024});
   ws.on('open',()=>{this.connectedAt=Date.now();this.pending.clear();this.subscriptions.clear();this.subscriptionErrors.clear();
    if(this.chain.family==='solana'){
     this.subscribe('slotSubscribe',[],{kind:'block'});
     if(this.chain.id==='solana')for(const p of SOLANA_POOL_PROGRAMS){this.subscribe('logsSubscribe',[{mentions:[p.id]},{commitment:'confirmed'}],{kind:'pool',program:p.id});this.store.setting('sol-log-head:'+p.id).then(until=>until&&enqueue(this.store,'catchup:'+p.id+':'+until,'SOLANA_CATCHUP',{program:p.id,until})).catch(()=>{});}
     for(const w of this.wallets)this.subscribe('logsSubscribe',[{mentions:[w.address]},{commitment:'confirmed'}],{kind:'wallet',wallet_id:w.id});
    }else{
     this.subscribe('eth_subscribe',['newHeads'],{kind:'block'});
     if(this.chain.id==='robinhood')this.subscribe('eth_subscribe',['logs',{address:RH.factory,topics:['0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9']}],{kind:'pool'});
    }
    this.status('SUBSCRIBING').catch(()=>{});
    this.ping=setInterval(()=>{if(ws.readyState===WebSocket.OPEN){if(Date.now()-(this.lastEvent||this.connectedAt)>45000)ws.terminate();else ws.ping();}},15000);this.ping.unref();
   });
   ws.on('message',bytes=>{this.message(bytes).catch(e=>this.status('ERROR',safeError(e)).catch(()=>{}));});
   ws.on('error',e=>{this.connectionError=safeError(e);this.status('ERROR',this.connectionError).catch(()=>{});});
   ws.on('close',()=>{clearInterval(this.ping);if(!this.closed){this.status('RECONNECTING',this.connectionError??'Conexión cerrada').catch(()=>{});this.retry();}});
  }catch(e){await this.status('ERROR',safeError(e));this.retry();}
 }
 subscribe(method,params,context){const id=++this.nextId;this.pending.set(id,context);this.socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));}
 retry(){if(this.closed)return;this.reconnects++;clearTimeout(this.timer);this.timer=setTimeout(()=>this.start(),Math.min(30000,1000*2**Math.min(5,this.reconnects))+Math.random()*500);this.timer.unref();}
 async message(bytes){
  const msg=JSON.parse(bytes.toString());if(msg.id){const context=this.pending.get(msg.id);this.pending.delete(msg.id);if(msg.error){this.subscriptionErrors.set(msg.id,safeError(Error(JSON.stringify(msg.error))));await this.status('DEGRADED',[...this.subscriptionErrors.values()].join('; '));return;}if(context)this.subscriptions.set(String(msg.result),context);return;}
  const context=this.subscriptions.get(String(msg.params?.subscription));if(!context)return;
  const result=msg.params.result,observedAt=Date.now();this.lastEvent=observedAt;
  if(context.kind==='block'){
   const block=this.chain.family==='solana'?String(result.slot):String(parseInt(result.number,16));
   if(Date.now()-this.lastPersist>=2000){this.lastPersist=Date.now();await this.status(this.subscriptionErrors.size||this.pending.size?'DEGRADED':'CONNECTED',this.subscriptionErrors.size?[...this.subscriptionErrors.values()].join('; '):this.pending.size?'Suscripciones pendientes':null,block);await emit(this.store,'BLOCK','Nuevo '+(this.chain.family==='solana'?'slot':'bloque'),{block,provider:new URL(this.url).hostname,transport:'WebSocket',hash:result.hash??null},this.chain.id);}
  }else{
   const backlog=await this.store.get("SELECT COUNT(*) n FROM engine_jobs WHERE state IN ('QUEUED','RUNNING')");if(backlog.n>=1000)await this.status('DEGRADED','Cola acumulada: revisar capacidad del proveedor; eventos guardados');
   if(context.kind==='wallet'&&!result.value?.err)await enqueue(this.store,'wallet:'+context.wallet_id+':'+result.value.signature,'WALLET_TX',{wallet_id:context.wallet_id,hash:result.value.signature,source:'WEBSOCKET',observed_at:observedAt});
   if(context.kind==='pool'){
    if(this.chain.family==='solana'){const v=result.value;if(!v?.err&&(v.logs??[]).some(l=>/Instruction: (CreatePool|Initialize|InitializeWithPermission)\b/.test(l)))await enqueue(this.store,'pool:'+v.signature,'SOLANA_POOL',{hash:v.signature});if(context.program&&v?.signature)await this.store.set('sol-log-head:'+context.program,v.signature);}
    else if(!result.removed)await enqueue(this.store,'pool:'+result.transactionHash+':'+result.logIndex,'EVM_POOL',{chain:this.chain.id,log:result});
   }
  }
 }
 async stop(){this.closed=true;clearTimeout(this.timer);clearInterval(this.ping);this.socket?.terminate();await this.status('STOPPED');}
}
export class NetworkStreams{
 constructor(store,options={}){this.store=store;this.options=options;this.streams=new Map();}
 async refresh(){
  const chains=await this.store.all('SELECT * FROM chains WHERE enabled=1');const wallets=await this.store.all('SELECT w.* FROM wallets w JOIN watched_wallets v ON v.wallet_id=w.id WHERE v.enabled=1');
  const active=new Set();for(const chain of chains){const url=inferredWebSocket(chain),watched=wallets.filter(w=>w.chain===chain.id);active.add(chain.id);
   if(!url){const old=this.streams.get(chain.id);if(old){await old.stream.stop();this.streams.delete(chain.id);}await this.store.run("INSERT INTO ws_health(chain,status,provider,error) VALUES (?,'NOT_CONFIGURED',?,?) ON CONFLICT(chain) DO UPDATE SET status='NOT_CONFIGURED',error=excluded.error",chain.id,new URL(chain.rpc_url).hostname,'Configurá WSS; monitoreo RPC disponible');continue;}
   const key=JSON.stringify([url,chain.rpc_url,watched.map(w=>[w.id,w.address])]);const old=this.streams.get(chain.id);if(old?.key===key)continue;if(old)await old.stream.stop();
   const stream=new NetworkStream(this.store,chain,watched,url,this.options.allowedRpcHosts??'');this.streams.set(chain.id,{key,stream});stream.start().catch(()=>{});
  }
  for(const [chain,{stream}] of this.streams)if(!active.has(chain)){await stream.stop();this.streams.delete(chain);}
 }
 async stop(){for(const {stream} of this.streams.values())await stream.stop();this.streams.clear();}
}
