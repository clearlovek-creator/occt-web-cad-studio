import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {selectRelease,validateRelease} from '../gateway/frontend-release.mjs';
const workspace=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2),index=args.indexOf('--release');
try{
  const release=index>=0?validateRelease(path.resolve(args[index+1]),workspace):selectRelease(path.join(workspace,'.releases'),workspace);
  if(index<0)process.argv.push('--release',release.directory);
  await import(pathToFileURL(path.join(release.directory,'runtime/scripts/frontend-server.mjs')).href);
}catch(error){console.error(JSON.stringify({type:'cad.startup',phase:'blocked',code:error.code||'FRONTEND_RELEASE_UNAVAILABLE',error:error.message}));process.exitCode=1;}
