import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {sqliteDriver} from './sqlite.mjs';
import {Store} from '../core/store.mjs';
import {copyEnvironment} from './copy/provider-config.mjs';
export async function runtimeContext(){
 const root=resolve(process.env.DATA_DIR??'.runtime');await mkdir(root,{recursive:true,mode:0o700});
 async function secret(name){const path=resolve(root,name);try{return (await readFile(path,'utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;const value=randomBytes(32).toString('base64');try{await writeFile(path,value,{mode:0o600,flag:'wx'});return value;}catch(error){if(error.code!=='EEXIST')throw error;return (await readFile(path,'utf8')).trim();}}}
 const encryptionKey=process.env.ENCRYPTION_KEY||await secret('master-key'),adminToken=process.env.ADMIN_TOKEN||await secret('admin-token');
 const copyEnv=copyEnvironment();
 const db=sqliteDriver(resolve(root,'meme-lab.sqlite')),store=new Store(db,{encryptionKey,copyProviders:copyEnv.providers});await store.init();
 const options={encryptionKey,jupiterKey:process.env.JUPITER_API_KEY??null,allowedRpcHosts:process.env.ALLOWED_RPC_HOSTS??'',runtime:'standalone',location:process.env.RUNTIME_LOCATION==='cloud'?'cloud':'local',engineAvailable:process.env.DISABLE_WORKER!=='1'};
 options.copyKeys=copyEnv.keys;options.paperOnly=copyEnv.freeBaseline===true;
 options.enableHistoryWorker=process.env.BSC_ENABLE_BACKFILL==='1';
 return {root,encryptionKey,adminToken,db,store,options};
}
