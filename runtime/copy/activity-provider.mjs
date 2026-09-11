import WebSocket from 'ws';
import {TRANSFER,packed,encode,cleanError} from '../../core/copy/common.mjs';
// Concurrent providers remain connected; each can supply heads and pending data.
export class WalletActivityProvider {
 constructor(provider,rpc,targets,onObservation,onHealth){Object.assign(this,{provider,rpc,targets,onObservation,onHealth});this.stopped=true;this.seq=0;this.requests=new Map();this.subscriptions=new Map();this.reconnects=0;this.lastPoll=0;this.busy=false;this.lastEvent=0;this.nextConnect=0;this.verified=false;this.subscriptionErrors=new Map();this.lastHealthAt=0;}
 start(){this.stopped=false;if(this.provider.ws_url)this.connect();this.timer=setInterval(()=>this.tick().catch(e=>this.health('ERROR',{error:cleanError(e)})),250);}
 health(status,data={}){if(status==='CONNECTED'&&[...this.subscriptionErrors.keys()].some(k=>!k.startsWith('pending')))status='DEGRADED';if(this.subscriptionErrors.size)data={...data,subscription_errors:Object.fromEntries(this.subscriptionErrors)};this.onHealth(this.provider.id,status,{method:this.provider.ws_url?'WEBSOCKET':'HTTP_FALLBACK',reconnects:this.reconnects,last_event:this.lastEvent,http:this.httpHealth??{status:'UNTESTED'},ws:{status:this.verified&&this.socket?.readyState===1?'CONNECTED':'DISCONNECTED',last_head_at:this.lastHeadAt??null},head_seen_count:this.headSeen??0,pending_seen_count:this.pendingSeen??0,pending_hashes_skipped:this.pendingSkipped??0,...data});}
 async connect(){if(this.stopped||this.socket&&[0,1].includes(this.socket.readyState)||Date.now()<Math.max(this.nextConnect,this.rpc.cooldown?.get(this.provider.id)??0))return;this.socket=new WebSocket(this.provider.ws_url,{handshakeTimeout:8000,maxPayload:8*1024*1024});this.verified=false;this.lastEvent=Date.now();this.socket.on('open',()=>{this.send('eth_chainId',[],'chain');});this.socket.on('message',data=>{try{this.message(JSON.parse(data.toString()));}catch(e){this.health('ERROR',{error:cleanError(e)});}});this.socket.on('error',()=>this.health('RECONNECTING',{error:'WSS_CONNECTION_FAILED'}));this.socket.on('close',()=>{this.requests.clear();this.subscriptions.clear();this.subscriptionErrors.clear();if(!this.stopped){this.reconnects++;this.nextConnect=Date.now()+Math.ceil(Math.min(this.reconnects>=8?300000:60000,1000*2**Math.min(9,this.reconnects))*(1+Math.random()*.2));this.health('RECONNECTING');}});}
 send(method,params,kind){const id=++this.seq;this.requests.set(id,kind);this.rpc.telemetry?.add(this.provider.id,method,{transport:'WS',units:this.provider.credit_unit??0});this.socket.send(encode({jsonrpc:'2.0',id,method,params}));}
 verificationFailed(error){
  this.verified=false;
  this.rpc.degrade?.(this.provider,String(error?.message??error));
  this.rpc.telemetry?.outcome(this.provider.id,'eth_chainId',{transport:'WS',error:String(error?.message??error)});
  this.health('ERROR',{error:'WSS_CHAIN_VERIFICATION_FAILED: '+cleanError(Error(String(error?.message??'Provider rejected chain verification').slice(0,160)))});
  // A live socket with a rejected chain handshake can never subscribe. Closing
  // it lets the normal retry loop recover after quota or credentials are fixed.
  this.socket?.close();
 }
 subscribePending(){
  if(this.provider.pending!=='ALCHEMY_FILTERED'&&this.provider.pending_budget_allowed===false){this.subscriptionErrors.set('pending','DISABLED_UNFILTERED_METERED_STREAM');return;}
  if(this.provider.pending==='ALCHEMY_FILTERED')this.send('eth_subscribe',['alchemy_pendingTransactions',{fromAddress:this.targets.map(t=>t.address),hashesOnly:false}],'pending');
  if(this.provider.pending==='STANDARD_FULL')this.send('eth_subscribe',['newPendingTransactions',true],'pending-full');
  if(this.provider.pending==='STANDARD_HASH')this.send('eth_subscribe',['newPendingTransactions'],'pending-hash');
 }
 async pending(event,receivedAt,receivedMono){
  if(typeof event==='object'){
   if(event.from&&this.targets.some(t=>t.address.toLowerCase()===event.from.toLowerCase()))this.onObservation({provider:this.provider.id,method:'WEBSOCKET',kind:'pending',event,received_at:receivedAt,received_mono:receivedMono});
   return;
  }
  if(typeof event!=='string'||!/^0x[\da-fA-F]{64}$/.test(event))return;
  // Never fan out a hash-only global feed into unrelated transaction lookups.
  // It cannot be filtered by sender until after the costly HTTP read.
  this.pendingSkipped=(this.pendingSkipped??0)+1;return;
 }
 message(msg){const receivedAt=Date.now(),receivedMono=performance.now();this.lastEvent=receivedAt;if(msg.id){const kind=this.requests.get(msg.id);this.requests.delete(msg.id);if(msg.error){if(kind==='chain'){this.verificationFailed(msg.error);return;}if(/429|quota|rate.?limit|request limit|maximum API usage|ran out of cu/i.test(msg.error.message??'')){this.rpc.degrade?.(this.provider,msg.error.message);this.rpc.telemetry?.outcome(this.provider.id,'eth_subscribe',{transport:'WS',error:msg.error.message});this.health('DEGRADED',{error:'WSS_SUBSCRIPTION_QUOTA_EXHAUSTED'});this.socket?.close();return;}if(kind==='pending-full'){this.subscriptionErrors.set('pending-full','FULL_PENDING_UNSUPPORTED_NO_HASH_FANOUT');this.health('CONNECTED');return;}this.subscriptionErrors.set(kind,'SUBSCRIPTION_UNAVAILABLE');this.health(kind==='pending'?'CONNECTED':'DEGRADED',{error:kind+': SUBSCRIPTION_UNAVAILABLE'});return;}if(kind==='chain'){if(Number(BigInt(msg.result))!==56){this.health('ERROR',{error:'WRONG_WSS_CHAIN'});this.socket.close();return;}this.verified=true;this.send('eth_subscribe',['newHeads'],'head');const wallets=this.targets.map(t=>packed(t.address));if(wallets.length&&this.provider.wallet_logs!==false){this.send('eth_subscribe',['logs',{topics:[TRANSFER,wallets]}],'log');this.send('eth_subscribe',['logs',{topics:[TRANSFER,null,wallets]}],'log');}this.subscribePending();return;}this.subscriptionErrors.delete(kind);this.subscriptions.set(msg.result,kind);this.health('CONNECTED',{subscriptions:this.subscriptions.size});return;}if(msg.method!=='eth_subscription'||!this.verified)return;const kind=this.subscriptions.get(msg.params?.subscription),event=msg.params?.result;if(event)this.rpc.telemetry?.add(this.provider.id,'eth_subscription:'+kind,{transport:'WS',notification:true,bytes:Buffer.byteLength(JSON.stringify(msg)),units:this.provider.notification_credit_per_byte?Buffer.byteLength(JSON.stringify(msg))*this.provider.notification_credit_per_byte:this.provider.credit_unit??0});if(event&&kind==='head'){this.headSeen=(this.headSeen??0)+1;this.lastHeadAt=receivedAt;this.rpc.headHealthyAt=receivedAt;};if(event&&kind?.startsWith('pending'))this.pendingSeen=(this.pendingSeen??0)+1;if(event&&Date.now()-this.lastHealthAt>1000){this.lastHealthAt=Date.now();this.health('CONNECTED',{block:event.number?Number(BigInt(event.number)):undefined,subscriptions:this.subscriptions.size});}if(kind?.startsWith('pending')){this.pending(event,receivedAt,receivedMono).catch(()=>{});return;}if(event)this.onObservation({provider:this.provider.id,method:'WEBSOCKET',kind,event,received_at:receivedAt,received_mono:receivedMono});}
 async tick(){
  if(this.stopped)return;
  let wsHealthy=this.provider.ws_url&&this.socket?.readyState===1&&this.verified&&[...this.subscriptions.values()].includes('head');
  if(wsHealthy&&Date.now()-(this.lastHeadAt??this.lastEvent)>20000){this.health('STALE');this.socket.terminate();wsHealthy=false;}
  if(this.provider.ws_url&&!wsHealthy)await this.connect();
  if(Date.now()<(this.rpc.cooldown?.get(this.provider.id)??0))return;if(this.busy||Date.now()-this.lastPoll<(wsHealthy||Date.now()-(this.rpc.headHealthyAt??0)<15000?30000:1000))return;
  this.lastPoll=Date.now();this.busy=true;const start=performance.now();
  try{
   if(!this.httpVerified){const chain=await this.rpc.request(this.provider,'eth_chainId');if(Number(BigInt(chain))!==56)throw Error('WRONG_HTTP_CHAIN');this.httpVerified=true;}
   const block=await (this.rpc.withContext?this.rpc.withContext({priority:0,pipeline:'HEALTH'},()=>this.rpc.request(this.provider,'eth_blockNumber')):this.rpc.request(this.provider,'eth_blockNumber')),now=Date.now();
   this.httpHealth={status:'CONNECTED',last_success_at:now,latency_ms:performance.now()-start,block:Number(BigInt(block))};
   if(block!==this.lastBlock){this.lastBlock=block;this.onObservation({provider:this.provider.id,method:'HTTP_FALLBACK',kind:'head',event:{number:block},received_at:now,received_mono:performance.now()});}
   this.health(wsHealthy?'CONNECTED':'RPC_ONLY',{block:Number(BigInt(block))});
  }catch(error){this.httpHealth={status:'ERROR',at:Date.now(),error:cleanError(error),retry_at:this.rpc.cooldown?.get(this.provider.id)??null};this.health(wsHealthy?'CONNECTED':'RECONNECTING');}
  finally{this.busy=false;}
 }

 stop(){this.stopped=true;clearInterval(this.timer);this.socket?.close();}
}
