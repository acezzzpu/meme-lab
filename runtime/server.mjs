
import {DashboardReader} from './dashboard-reader.mjs';
import {streamSse} from './sse.mjs';
import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {runtimeContext} from './context.mjs';
import {supervise} from './supervisor.mjs';
import {resolvePublicPath} from './static-path.mjs';
import {handle} from '../core/service.mjs';
import {loadSigners} from './signers.mjs';
import {safeError} from '../core/util.mjs';
const {root,adminToken,db,store,options}=await runtimeContext();await store.set('engine_enforced',process.env.DISABLE_WORKER!=='1');
const signers=await loadSigners(process.env);Object.assign(options,{signerPublicKeys:signers.publicKeys,localSigner:signers.sign});
const supervisor=process.env.DISABLE_WORKER==='1'?null:supervise(store);
const dashboard=new DashboardReader(resolve(root,'meme-lab.sqlite'),{runtime:options.runtime,location:options.location,engineAvailable:options.engineAvailable,encryptionKey:options.encryptionKey,signerPublicKeys:options.signerPublicKeys,copyProviders:options.copyProviders});
const sessions=new Map(),streams=new Set();const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
let operation=Promise.resolve();const serial=fn=>{const p=operation.then(fn);operation=p.catch(()=>{});return p;};
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.json':'application/json','.zip':'application/zip'};
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://'+req.headers.host);const respond=(data,status=200)=>{if(res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};try{
 const bearer=process.env.REMOTE_API_TOKEN&&safeEqual(req.headers.authorization??'','Bearer '+process.env.REMOTE_API_TOKEN);
 if(!bearer&&req.method!=='GET'&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return respond({error:'ORIGIN_REJECTED'},403);
 // Opening the public panel from an external link is a safe document navigation.
 // API reads, streams, login, mutations and embedded resources remain protected.
 const panelNavigation=req.method==='GET'&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document'&&url.pathname!=='/api'&&!url.pathname.startsWith('/api/')&&url.pathname!=='/healthz';
 if(!bearer&&req.headers['sec-fetch-site']==='cross-site'&&!panelNavigation)return respond({error:'CROSS_SITE_REQUEST_REJECTED'},403);
 let body={};if(req.method!=='GET'){let text='';for await(const chunk of req){text+=chunk;if(text.length>100000)throw Error('PAYLOAD_TOO_LARGE');}body=text?JSON.parse(text):{};}
 if(url.pathname==='/healthz'){const beat=await store.setting('engine_heartbeat'),desired=await store.setting('engine_desired');return respond({api:'OK',release:'0.6.0-bnb-free-budget',engine:desired==='RUNNING'?(beat&&Date.now()-beat.at<15000?beat.state:'OFFLINE'):'STOPPED'},desired==='RUNNING'&&(!beat||Date.now()-beat.at>=15000)?503:200);}
 if(url.pathname==='/api/auth/login'){
  if(req.method!=='POST')return respond({error:'METHOD_NOT_ALLOWED'},405);
  if(!safeEqual(String(body.token??''),adminToken))return respond({error:'INVALID_TOKEN'},401);
  const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+12*3600000);res.setHeader('Set-Cookie',`meme_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);return respond({ok:true});
 }
 if(url.pathname.startsWith('/api/')){
  const session=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('meme_session='))?.slice(13);
  if(!bearer&&(!session||!(sessions.get(session)>Date.now())))return respond({error:'AUTH_REQUIRED'},401);
  if(req.method==='GET'&&url.pathname==='/api/lab/state'){const json=await dashboard.bootstrap();if(res.writableEnded||res.destroyed)return;res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(json);return;}
  if(req.method==='GET'&&url.pathname==='/api/lab/history/events')return respond(await dashboard.history({source:url.searchParams.get('source')??'events',before:Number(url.searchParams.get('before')??Number.MAX_SAFE_INTEGER),limit:Number(url.searchParams.get('limit')??25),id:url.searchParams.has('id')?Number(url.searchParams.get('id')):null,offset:Number(url.searchParams.get('offset')??0)}));
  if(url.pathname==='/api/stream'){
   streams.add(res);
   await streamSse(req,res,{
    initialCursor:Math.max(0,Number(req.headers['last-event-id']??url.searchParams.get('after')??0)||0),
    loadCursor:async()=>Math.max(0,(await store.get('SELECT MAX(id) id FROM engine_events')).id-80),
    eventsAfter:async()=>[],state:()=>dashboard.read(),stateEvent:'current',
    authorized:()=>bearer||sessions.get(session)>Date.now(),onClose:()=>streams.delete(res)
   });return;
  }
  const path=url.pathname.replace('/api/lab/','');const fn=()=>handle(store,path,req.method,body,options);
  const urgent=['copy/stop','copy/emergency','copy/pause','stop','engine/start','engine/stop','engine/emergency','engine/pause','engine/resume'].includes(path);
  const result=req.method==='GET'||urgent?await fn():await serial(fn);return respond(result);
 }
 const publicRoot=resolve('standalone-dist');let filepath=resolvePublicPath(publicRoot,url.pathname);
 try{if((await stat(filepath)).isDirectory())filepath=resolve(publicRoot,'index.html');}
 catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;if(extname(filepath)||url.pathname.startsWith('/assets/'))return respond({error:'STATIC_FILE_NOT_FOUND'},404);filepath=resolve(publicRoot,'index.html');}
 const content=await readFile(filepath);res.writeHead(200,{'Content-Type':mime[extname(filepath)]??'application/octet-stream','Cache-Control':extname(filepath)==='.html'?'no-store':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"});res.end(content);
 }catch(e){respond({error:safeError(e)},e.message==='NOT_FOUND'?404:400);}});
const port=Number(process.env.PORT??8787);server.listen(port,process.env.HOST??'127.0.0.1',()=>console.log(`MEME LAB running at http://${process.env.HOST??'127.0.0.1'}:${port}. Token: DATA_DIR/admin-token. Engine runs in a supervised background process.`));
let closing=false;async function shutdown(){if(closing)return;closing=true;for(const stream of streams)stream.end();server.close();server.closeIdleConnections();await dashboard.close();await supervisor?.stop();await operation;db.close();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,shutdown);
