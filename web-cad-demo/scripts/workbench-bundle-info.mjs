import {validateWorkbenchBundle} from '../gateway/workbench-bundle.mjs';
if(process.argv.length!==3)throw Error('Exactly one workbench bundle directory is required.');
const started=performance.now();
const progress=phase=>console.error(JSON.stringify({type:'cad.bundle.preflight',phase,pid:process.pid,elapsedMs:Math.round(performance.now()-started)}));
progress('started');
const bundle=validateWorkbenchBundle(process.argv[2],{onProgress:progress});
console.log(JSON.stringify({ok:true,releaseId:bundle.releaseId,manifestSha256:bundle.manifestSha256,nodeExecutable:bundle.nodeExecutable,frontendDirectory:bundle.frontendDirectory,backendDirectory:bundle.backendDirectory}));
