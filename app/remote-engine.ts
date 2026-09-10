import {env} from 'cloudflare:workers';
export function remoteEngineConfigured(){const b=env as unknown as Record<string,string>;return !!b.REMOTE_ENGINE_URL&&!!b.REMOTE_ENGINE_TOKEN;}
export async function proxyEngine(request:Request,path:string,stream=false){
 const b=env as unknown as Record<string,string>;if(!b.REMOTE_ENGINE_URL||!b.REMOTE_ENGINE_TOKEN)return null;
 const base=new URL(b.REMOTE_ENGINE_URL);if(base.protocol!=='https:'||base.username||base.password)throw Error('REMOTE_ENGINE_REQUIRES_HTTPS');
 const url=new URL(path,base);const headers=new Headers({'Authorization':'Bearer '+b.REMOTE_ENGINE_TOKEN,'Content-Type':'application/json'});
 if(request.headers.get('last-event-id'))headers.set('Last-Event-ID',request.headers.get('last-event-id')!);
 const result=await fetch(url,{method:request.method,headers,body:request.method==='GET'?undefined:await request.text(),redirect:'error',signal:stream?request.signal:AbortSignal.any([request.signal,AbortSignal.timeout(30000)])});
 return new Response(result.body,{status:result.status,headers:{'Content-Type':stream?'text/event-stream':'application/json','Cache-Control':'no-store, no-transform',...(stream?{'X-Accel-Buffering':'no'}:{})}});
}
