import {Wallet} from 'ethers';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {homedir,userInfo} from 'node:os';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const folder=resolve(homedir(),'MEME-LAB-Secrets');await mkdir(folder,{recursive:true,mode:0o700});
if(process.platform==='win32'){const user=process.env.USERDOMAIN?process.env.USERDOMAIN+'\\'+userInfo().username:userInfo().username;execFileSync('icacls',[folder,'/inheritance:r','/grant:r',user+':(OI)(CI)F'],{stdio:'ignore'});}
const keyFile=resolve(folder,'bnb-copy-keystore.json'),passwordFile=resolve(folder,'bnb-copy-password');let address;
try{const k=JSON.parse(await readFile(keyFile,'utf8'));await stat(passwordFile);address='0x'+k.address;console.log('Se conserva la wallet dedicada existente.');}catch(e){if(e.code!=='ENOENT')throw e;let exists=false;try{await stat(keyFile);exists=true;}catch{}if(exists)throw Error('Existe keystore sin contraseña: restaurá tu backup; no se sobrescribe.');const wallet=Wallet.createRandom(),password=randomBytes(48).toString('base64');const encrypted=await wallet.encrypt(password);await writeFile(passwordFile,password,{flag:'wx',mode:0o600});await writeFile(keyFile,encrypted,{flag:'wx',mode:0o600});address=wallet.address;}
const envFile=resolve('.env');let env='';try{env=await readFile(envFile,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}for(const [key,value] of Object.entries({BNB_KEYSTORE_FILE:keyFile,BNB_PASSWORD_FILE:passwordFile})){const line=key+'="'+value.replaceAll('\\','/')+'"';const regex=new RegExp('^'+key+'=.*$','m');env=regex.test(env)?env.replace(regex,line):env.trimEnd()+'\n'+line+'\n';}await writeFile(envFile,env,{mode:0o600});
console.log('Dirección pública BNB: '+address);
console.log('Configuración guardada en .env. Reiniciá MEME LAB; copiá esta dirección en Copy Trading → Capital y wallet.');
console.log('No se movieron fondos. Hacé backup privado de '+folder+'. Nunca compartas el keystore ni el archivo de contraseña.');
