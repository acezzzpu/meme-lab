import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {Store,d1Driver} from '@/core/store.mjs';
import {state} from '@/core/service.mjs';
import {eventsAfter} from '@/core/engine-state.mjs';
import {proxyEngine} from '@/app/remote-engine';
export async function GET(request:Request){
 const user=await getChatGPTUser();if(!user)return new Response('Unauthorized',{status:401});
 const bindings=env as unknown as {DB:D1Database;ENCRYPTION_KEY?:string};const store=new Store(d1Driver(bindings.DB),{encryptionKey:bindings.ENCRYPTION_KEY});
 const owner=await store.setting('owner');if(owner&&owner!==user.userId)return new Response('Forbidden',{status:403});
 const remote=await proxyEngine(request,'/api/stream',true);if(remote)return remote;
 const encoder=new TextEncoder();let timer:ReturnType<typeof setInterval>,ticks=0,busy=false,closed=false,cursor=Math.max(0,Number(request.headers.get('last-event-id'))||0);
 const stream=new ReadableStream({start(controller){
  const close=()=>{closed=true;clearInterval(timer);try{controller.close();}catch{}};
  const push=async()=>{if(busy||closed)return;busy=true;try{const events=await eventsAfter(store,cursor,100);for(const event of events){controller.enqueue(encoder.encode('id: '+event.id+'\nevent: engine\ndata: '+JSON.stringify(event)+'\n\n'));cursor=event.id;}controller.enqueue(encoder.encode('event: state\ndata: '+JSON.stringify(await state(store,{runtime:'hosted',encryptionKey:bindings.ENCRYPTION_KEY,engineAvailable:false,signerPublicKeys:{}}))+'\n\n'));if(++ticks>=8)close();}catch{close();}finally{busy=false;}};
  push();timer=setInterval(push,5000);request.signal.addEventListener('abort',close);
 },cancel(){closed=true;clearInterval(timer);}});
 return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform'}});
}
