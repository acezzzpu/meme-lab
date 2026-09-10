import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {Store,d1Driver} from '@/core/store.mjs';
import {handle} from '@/core/service.mjs';
import {safeError} from '@/core/util.mjs';
import {proxyEngine} from '@/app/remote-engine';
async function dispatch(request:Request){try{const user=await getChatGPTUser();if(!user)return Response.json({error:'AUTH_REQUIRED'},{status:401});const url=new URL(request.url);if(request.method!=='GET'&&request.headers.get('origin')!==url.origin)return Response.json({error:'ORIGIN_REJECTED'},{status:403});const bindings=env as unknown as {DB:D1Database;ENCRYPTION_KEY?:string;JUPITER_API_KEY?:string};const store=new Store(d1Driver(bindings.DB),{encryptionKey:bindings.ENCRYPTION_KEY});const owner=await store.setting('owner');if(owner&&owner!==user.userId)return Response.json({error:'OWNER_ONLY'},{status:403});if(!owner){await store.run('INSERT OR IGNORE INTO settings VALUES (?,?,?)','owner',JSON.stringify(user.userId),Date.now());if(await store.setting('owner')!==user.userId)return Response.json({error:'OWNER_ONLY'},{status:403});}const remote=await proxyEngine(request,url.pathname);if(remote)return remote;const text=request.method==='GET'?'{}':await request.text();if(text.length>100000)return Response.json({error:'PAYLOAD_TOO_LARGE'},{status:413});const result=await handle(store,url.pathname.replace('/api/lab/',''),request.method,JSON.parse(text),{encryptionKey:bindings.ENCRYPTION_KEY,jupiterKey:bindings.JUPITER_API_KEY,runtime:'hosted',signerPublicKeys:{}});return Response.json(result,{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:safeError(e)},{status:400});}}
export const GET=dispatch;
export const POST=dispatch;
