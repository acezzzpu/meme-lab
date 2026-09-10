import test from 'node:test';
import assert from 'node:assert/strict';
import {win32,posix} from 'node:path';
import {resolvePublicPath} from '../runtime/static-path.mjs';

for(const [name,pathApi,root] of [['Windows',win32,'C:\\Users\\Ace\\MEME LAB\\standalone-dist'],['POSIX',posix,'/tmp/MEME LAB/standalone-dist']]){
 test(name+': public document, JS, CSS and names with spaces remain inside output',()=>{
  assert.equal(resolvePublicPath(root,'/',pathApi),root);
  for(const name of ['assets/index.js','assets/index.css','assets/my%20icon.svg','assets/..valid.svg'])assert.equal(resolvePublicPath(root,'/'+name,pathApi),pathApi.join(root,decodeURIComponent(name)));
 });
 test(name+': traversal cannot access parent or similarly named sibling directories',()=>{
  for(const pathname of ['/../private.txt','/%2e%2e/private.txt','/../standalone-dist-other/private.txt','/assets/%2e%2e/%2e%2e/private.txt'])assert.throws(()=>resolvePublicPath(root,pathname,pathApi),/PATH_REJECTED/);
 });
}
test('Windows: encoded backslashes cannot escape the output directory',()=>{
 for(const pathname of ['/%2e%2e%5cprivate.txt','/assets%5c..%5c..%5cprivate.txt','/..\\private.txt'])assert.throws(()=>resolvePublicPath('C:\\app\\standalone-dist',pathname,win32),/PATH_REJECTED/);
});
