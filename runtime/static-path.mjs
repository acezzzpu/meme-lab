import path from 'node:path';

// Use the filesystem's path rules; Windows paths use backslashes.
export function resolvePublicPath(publicRoot,pathname,pathApi=path){
 const filename=pathApi.resolve(publicRoot,'.'+decodeURIComponent(pathname));
 const relative=pathApi.relative(publicRoot,filename);
 if(relative==='..'||relative.startsWith('..'+pathApi.sep)||pathApi.isAbsolute(relative))throw Error('PATH_REJECTED');
 return filename;
}
