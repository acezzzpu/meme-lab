import {http} from './provider-http.mjs';
export {http};
export const id=()=>crypto.randomUUID();
export const json=(s,f=null)=>{try{return JSON.parse(s);}catch{return f;}};
export const finite=(n)=>n===null||n===undefined||n===''?null:Number.isFinite(Number(n))?Number(n):null;
export const fail=(condition,message)=>{if(!condition)throw Error(message);};
export const rawAmount=(x)=>{fail(typeof x==='string'&&/^[1-9][0-9]{0,77}$/.test(x),'INVALID_BASE_UNITS');return BigInt(x);};
export const decimalToRaw=(value,decimals)=>{fail(/^\d+(\.\d+)?$/.test(String(value)),'INVALID_DECIMAL');const [w,f='']=String(value).split('.');fail(f.length<=decimals,'TOO_MANY_DECIMALS');return BigInt(w+f.padEnd(decimals,'0')).toString();};
export async function digest(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof bytes==='string'?new TextEncoder().encode(bytes):bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
export function safeError(e){return String(e?.message??e).replace(/(?:https?|wss?):\/\/[^\s"']+/g,'[provider]').replace(/(api[_-]?key|authorization|token|secret)[=:]\s*[^\s,;]+/gi,'$1=[REDACTED]').slice(0,400);}
export function validateEndpoint(url,extra=''){const u=new URL(url);const approved=['solana.com','solana-rpc.publicnode.com','helius-rpc.com','quiknode.pro','alchemy.com','chain.robinhood.com','bnbchain.org','base.org','ankr.com',...extra.split(',').filter(Boolean)];fail(u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&approved.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)),'ENDPOINT_HOST_NOT_ALLOWED');return url;}
export async function rpc(url,method,params=[]){const body=await http(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(body.error)throw Error(`RPC_${body.error.code}: ${String(body.error.message).slice(0,160)}`);fail(Object.hasOwn(body,'result'),'MALFORMED_RPC');return body.result;}
export async function encrypt(text,key){fail(key,'SECRET_STORAGE_NOT_CONFIGURED');const iv=crypto.getRandomValues(new Uint8Array(12));const k=await crypto.subtle.importKey('raw',Uint8Array.from(Buffer.from(key,'base64')),'AES-GCM',false,['encrypt']);return Buffer.from(iv).toString('base64')+'.'+Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv},k,new TextEncoder().encode(text))).toString('base64');}
export async function decrypt(text,key){const [iv,data]=text.split('.');const k=await crypto.subtle.importKey('raw',Uint8Array.from(Buffer.from(key,'base64')),'AES-GCM',false,['decrypt']);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(iv,'base64')},k,Buffer.from(data,'base64')));}
