import path from 'node:path';
import {selectRelease} from '../gateway/frontend-release.mjs';
const workspace=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2);
try{
  const release=selectRelease(args[0]||path.join(workspace,'.releases'),workspace,args[1]||undefined);
  console.log(JSON.stringify({releaseId:release.releaseId,directory:release.directory,builtAt:release.builtAt,apiMode:release.apiMode}));
}catch(error){console.error(JSON.stringify({type:'cad.startup',phase:'blocked',code:error.code||'FRONTEND_RELEASE_UNAVAILABLE',error:error.message}));process.exitCode=1;}
