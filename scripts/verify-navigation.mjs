// Real local HTTP requests with browser Fetch Metadata headers; no external providers.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dataDir=await mkdtemp(join(tmpdir(),'meme-lab-navigation-'));
const server=spawn(process.execPath,['runtime/server.mjs'],{env:{...process.env,DATA_DIR:dataDir,DISABLE_WORKER:'1',PORT:'8797',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
const checks=[];
async function request(path='/',{method='GET',headers={},body}={}){
 const serialized=body===undefined?null:JSON.stringify(body);
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:8797,path,method,headers:{...headers,...(serialized?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(serialized)}:{})}},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});
  req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('HTTP_TIMEOUT')));req.end(serialized);
 });
}
const crossNav={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
async function check(name,path,options,status){const r=await request(path,options);assert.equal(r.status,status,name+': '+r.text.slice(0,120));checks.push(name);return r;}
try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('SERVER_START_TIMEOUT')),10000);server.stdout.on('data',d=>{if(String(d).includes('MEME LAB running')){clearTimeout(timer);resolve();}});server.once('exit',code=>{clearTimeout(timer);reject(Error('SERVER_EXIT_'+code));});});
 await check('Address-bar navigation serves UI','/',{},200);
 const linked=await check('External link opens public UI','/',{headers:crossNav},200);assert.match(linked.headers['content-type'],/text\/html/);assert.match(linked.text,/MEME LAB/);assert.match(linked.headers['content-security-policy'],/frame-ancestors 'none'/);
 const assets=[...linked.text.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(match=>match[1]);
 assert.ok(assets.some(asset=>asset.endsWith('.js')),'Built HTML must load a JavaScript entrypoint');
 assert.ok(assets.some(asset=>asset.endsWith('.css')),'Built HTML must load a stylesheet');
 for(const asset of assets){
  const served=await check('Built asset loads '+asset,asset,{headers:{'Sec-Fetch-Site':'same-origin'}},200);
  assert.match(served.headers['content-type'],asset.endsWith('.js')?/text\/javascript/:/text\/css/);
  assert.equal(served.text,await readFile('standalone-dist'+asset,'utf8'),'HTTP must return the actual built file');
  assert.equal(served.headers['x-content-type-options'],'nosniff');
 }
 for(const missing of ['/assets/missing.js','/assets/missing.css','/assets/missing']){
  const absent=await check('Missing asset returns 404 '+missing,missing,{},404);assert.equal(JSON.parse(absent.text).error,'STATIC_FILE_NOT_FOUND');
 }
 await check('External link to client route serves UI','/dashboard',{headers:crossNav},200);
 await check('Cross-site fetch stays blocked','/',{headers:{...crossNav,'Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'}},403);
 await check('Cross-site iframe stays blocked','/',{headers:{...crossNav,'Sec-Fetch-Dest':'iframe'}},403);
 await check('Missing navigation metadata stays blocked','/',{headers:{'Sec-Fetch-Site':'cross-site'}},403);
 await check('Cross-site POST to UI stays blocked','/',{method:'POST',headers:crossNav,body:{}},403);
 await check('Reserved API root stays blocked','/api',{headers:crossNav},403);
 await check('Unauthenticated API stays private','/api/lab/state',{},401);
 const token=(await readFile(join(dataDir,'admin-token'),'utf8')).trim();
 await check('Cross-site login stays blocked even with correct token','/api/auth/login',{method:'POST',headers:crossNav,body:{token}},403);
 const login=await check('Same-origin login succeeds','/api/auth/login',{method:'POST',headers:{Origin:'http://127.0.0.1:8797','Sec-Fetch-Site':'same-origin'},body:{token}},200);
 const Cookie=login.headers['set-cookie'][0].split(';')[0];
 await check('Authenticated same-origin state succeeds','/api/lab/state',{headers:{Cookie,'Sec-Fetch-Site':'same-origin'}},200);
 for(const path of ['/api/lab/state','/api/stream'])await check('Cross-site authenticated '+path+' stays blocked',path,{headers:{...crossNav,Cookie}},403);
 await check('Cross-origin mutation stays blocked','/api/lab/stop',{method:'POST',headers:{Cookie,Origin:'https://example.invalid'},body:{}},403);
 await check('Same-origin control succeeds','/api/lab/stop',{method:'POST',headers:{Cookie,Origin:'http://127.0.0.1:8797','Sec-Fetch-Site':'same-origin'},body:{}},200);
 await writeFile('docs/evidence/navigation-verification.json',JSON.stringify({at:new Date().toISOString(),status:'PASSED',checks},null,2));
 console.log(checks.join('\n'));
}finally{
 if(server.exitCode===null){const exited=once(server,'exit');server.kill('SIGTERM');await exited;}
 await rm(dataDir,{recursive:true,force:true});
}
