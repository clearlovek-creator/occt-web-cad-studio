import path from 'node:path';
import {collectNativeRuntimeProfile} from './native-runtime-release.mjs';
import {fileInventory} from './frontend-release.mjs';
import {DiscreteSurfaceClient} from './discrete-surface-client.mjs';
import {discreteMemoryPolicy} from './native-resource-policy.mjs';
const fault=()=>Object.assign(Error('表面重构运行目录缺失、改变或不属于封存版本；没有启动替代引擎。'),{code:'SURFACE_RUNTIME_INVALID',status:503});
const sorted=files=>[...files].sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
/** Captures an explicit, self-contained PE closure; sealed releases cannot opt
 * into a workspace binary through inherited environment or an application .env. */
export function configureDiscreteSurfaceRuntime({mode='workspace-source',sealed=null,environment=process.env,Client=DiscreteSurfaceClient}={}){
  const policy=discreteMemoryPolicy(environment);let runtime;
  if(mode==='project-code-snapshot')runtime=sealed;
  else if(environment.DISCRETE_SURFACE_WORKER_PATH){
    const workerPath=path.resolve(environment.DISCRETE_SURFACE_WORKER_PATH),runtimePath=path.resolve(environment.DISCRETE_SURFACE_RUNTIME_BIN||path.dirname(workerPath));
    if(path.dirname(workerPath)!==runtimePath)throw fault();
    try{const profile=collectNativeRuntimeProfile({roles:{discrete:workerPath},search:[runtimePath]});runtime={workerPath,runtimePath,files:profile.entries.map(entry=>entry.proof),distributionQualified:false};}catch{throw fault();}
  }else if(environment.DISCRETE_SURFACE_RUNTIME_BIN)throw fault();
  if(!runtime)return {factory:null,memoryLimitBytes:policy.limitBytes,status:()=>({configured:false,state:'not-configured',publicDistributionQualified:false,automaticReplay:false})};
  runtime=structuredClone(runtime);
  const verify=()=>{try{if(path.dirname(runtime.workerPath)!==runtime.runtimePath||!runtime.files.some(item=>item.file===path.basename(runtime.workerPath))||JSON.stringify(fileInventory(runtime.runtimePath))!==JSON.stringify(sorted(runtime.files)))throw fault();}catch{throw fault();}};
  verify();
  return {memoryLimitBytes:policy.limitBytes,factory:({validate}={})=>{verify();return new Client({workerPath:runtime.workerPath,runtimePath:runtime.runtimePath,memoryLimitBytes:policy.limitBytes,...validate&&{validate}});},status:()=>({configured:true,state:'configured',basis:mode==='project-code-snapshot'?'sealed-pe-closure-v1':'explicit-pe-closure-v1',files:runtime.files.length,licenseRoute:'GPL-3.0-or-later',publicDistributionQualified:false,automaticReplay:false})};
}
