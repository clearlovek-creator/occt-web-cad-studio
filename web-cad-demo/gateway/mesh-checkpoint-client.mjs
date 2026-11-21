import {SingleJobNativeClient} from './single-job-native-client.mjs';
import {meshMemoryPolicy,meshResourceExitError} from './native-resource-policy.mjs';
import {DiscreteTetraError} from './discrete-tetra-protocol.mjs';
import {MESH_CHECKPOINT_PROTOCOL as P,normalizeCheckpointInput,assertCheckpointInput,assertCheckpointHandshake,assertCheckpointResult,assertOptimizationCheckpointInput,assertCheckpointOptimizationResult,checkpointOptimizationFailure} from './mesh-checkpoint-protocol.mjs';
import {patchedCheckpointRequest,assertPatchedCheckpointRequest,assertPatchedCheckpointHandshake,assertPatchedCheckpointResult,assertPatchedOptimizationInput,assertPatchedOptimizationResult,patchedOptimizationFailure} from './patched-checkpoint-protocol.mjs';
const profile=Object.freeze({service:'gmsh-mesh-worker',prefix:'MESH_',label:'隔离网格优化',requestPrefix:'mesh-checkpoint-',closedChannelCode:'MESH_WORKER_EXITED',args:Object.freeze(['--discrete-checkpoint-single-job']),maxRequestBytes:P.maxRequestBytes,maxResponseBytes:P.maxResponseBytes,memoryVariable:'MESH_WORKER_MEMORY_LIMIT_BYTES',memoryPolicy:meshMemoryPolicy,resourceExit:meshResourceExitError,fault:(code,message)=>new DiscreteTetraError(code,message),operations:Object.freeze({
  'mesh.discrete-checkpoint':{input:assertCheckpointInput,handshake:assertCheckpointHandshake,result:assertCheckpointResult},
  'mesh.discrete-optimize':{input:assertOptimizationCheckpointInput,handshake:health=>assertCheckpointHandshake(health,{optimization:true}),result:assertCheckpointOptimizationResult,failure:checkpointOptimizationFailure},
  'mesh.discrete-patched-checkpoint':{input:assertPatchedCheckpointRequest,handshake:assertPatchedCheckpointHandshake,result:assertPatchedCheckpointResult},
  'mesh.discrete-patched-optimize':{input:assertPatchedOptimizationInput,handshake:health=>assertPatchedCheckpointHandshake(health,{optimization:true}),result:assertPatchedOptimizationResult,failure:patchedOptimizationFailure},
})});
export class MeshCheckpointClient extends SingleJobNativeClient{
  constructor(options){super({...options,profile});}
  createCheckpoint(input,{sourceInput,signal}={}){return this.execute('mesh.discrete-checkpoint',normalizeCheckpointInput(input),{signal,context:{sourceInput}});}
  optimizeCheckpoint(input,{sourceInput,signal}={}){return this.execute('mesh.discrete-optimize',input,{signal,context:{sourceInput}});}
  createPatchedCheckpoint(input,{sourceInput,signal}={}){return this.execute('mesh.discrete-patched-checkpoint',patchedCheckpointRequest(input),{signal,context:{sourceInput}});}
  optimizePatchedCheckpoint(input,{sourceInput,signal}={}){return this.execute('mesh.discrete-patched-optimize',input,{signal,context:{sourceInput}});}
}
