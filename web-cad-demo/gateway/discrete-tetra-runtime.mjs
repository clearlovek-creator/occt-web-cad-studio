import path from 'node:path';
import {fileInventory} from './frontend-release.mjs';
import {DiscreteTetraClient} from './discrete-tetra-client.mjs';
import {DiscreteTetraTaskClient} from './discrete-tetra-task-client.mjs';
import {MeshCheckpointClient} from './mesh-checkpoint-client.mjs';
import {meshMemoryPolicy} from './native-resource-policy.mjs';

/** Task integration uses the existing sealed mesh role, never an executable
 * found on PATH or an independent fourth native-runtime profile. */
export function configureDiscreteTetraRuntime({mode,sealedMesh,surfaceRuntime,environment=process.env,Client=DiscreteTetraClient,CheckpointClient=MeshCheckpointClient}={}){
  const memoryLimitBytes=meshMemoryPolicy(environment).limitBytes;
  if(mode!=='project-code-snapshot'||!sealedMesh||!surfaceRuntime?.factory)return {factory:null,memoryLimitBytes};
  const mesh=structuredClone(sealedMesh),expected=[...mesh.files].sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
  const verify=()=>{try{if(path.dirname(mesh.workerPath)!==mesh.runtimePath||!expected.some(item=>item.file===path.basename(mesh.workerPath))||JSON.stringify(fileInventory(mesh.runtimePath))!==JSON.stringify(expected))throw Error();}catch{throw Object.assign(Error('离散四面体运行目录不属于原封存版本，未启动替代引擎。'),{code:'MESH_DISCRETE_RUNTIME_INVALID'});}};
  verify();const factory=({validate}={})=>{verify();const options={workerPath:mesh.workerPath,runtimePath:mesh.runtimePath,memoryLimitBytes,...validate&&{validate}};return new DiscreteTetraTaskClient({partitionClient:surfaceRuntime.factory({validate}),tetraClient:new Client(options),checkpointClient:new CheckpointClient(options)});};
  Object.defineProperties(factory,{checkpointSupported:{value:true},constrainedSupported:{value:true}});return {memoryLimitBytes,factory};
}
