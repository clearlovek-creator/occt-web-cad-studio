import path from 'node:path';
import {createWorkbenchBundle} from '../gateway/workbench-bundle.mjs';
import {parseWorkbenchBundleArguments} from './workbench-bundle-arguments.mjs';
const options=parseWorkbenchBundleArguments(process.argv.slice(2));
const result=createWorkbenchBundle({workspace:path.resolve(import.meta.dirname,'..'),...options});
console.log(JSON.stringify({ok:true,releaseId:result.releaseId,directory:result.directory,manifestSha256:result.manifestSha256,files:result.files.length,bytes:result.files.reduce((sum,file)=>sum+file.bytes,0),nodeVersion:result.nodeVersion,frontend:result.frontend,backend:result.backend,scope:result.scope}));
