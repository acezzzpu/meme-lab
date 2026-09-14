import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
export function writeEvidence(name,value){
 const dir=resolve(process.env.V4_OUTPUT_DIR??'outputs/v4');mkdirSync(dir,{recursive:true});
 const file=join(dir,`${name}-${Date.now()}-${randomUUID().slice(0,8)}.json`);
 writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx'});console.log('Evidence:',file);return file;
}
