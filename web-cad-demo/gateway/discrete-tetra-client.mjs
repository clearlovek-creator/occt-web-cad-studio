import {SingleJobNativeClient} from './single-job-native-client.mjs';
import {meshMemoryPolicy,meshResourceExitError} from './native-resource-policy.mjs';
import {DISCRETE_TETRA_PROTOCOL as P,DiscreteTetraError,normalizeDiscreteTetraInput,assertDiscreteTetraInput,assertDiscreteTetraHandshake,assertDiscreteTetraResult,discreteTetraFailure} from './discrete-tetra-protocol.mjs';
import {assertConstrainedDiscreteTetraInput,assertConstrainedDiscreteTetraHandshake,assertConstrainedDiscreteTetraResult,constrainedDiscreteTetraFailure} from './discrete-tetra-protocol.mjs';
import {assertPatchedDiscreteTetraInput,assertPatchedDiscreteTetraHandshake,assertPatchedDiscreteTetraResult,patchedDiscreteTetraFailure} from './patched-tetra-protocol.mjs';
const profile=Object.freeze({
  service:'gmsh-mesh-worker',prefix:'MESH_',label:'离散四面体',requestPrefix:'tetra-',closedChannelCode:'MESH_WORKER_EXITED',args:Object.freeze(['--discrete-single-job']),
  maxRequestBytes:P.maxRequestBytes,maxResponseBytes:P.maxResponseBytes,
  memoryVariable:'MESH_WORKER_MEMORY_LIMIT_BYTES',memoryPolicy:meshMemoryPolicy,resourceExit:meshResourceExitError,
  fault:(code,message)=>new DiscreteTetraError(code,message),
  operations:Object.freeze({'mesh.discrete-tetra':{input:assertDiscreteTetraInput,handshake:assertDiscreteTetraHandshake,result:assertDiscreteTetraResult,failure:discreteTetraFailure},'mesh.discrete-constrained-tetra':{input:assertConstrainedDiscreteTetraInput,handshake:assertConstrainedDiscreteTetraHandshake,result:assertConstrainedDiscreteTetraResult,failure:constrainedDiscreteTetraFailure},'mesh.discrete-patched-tetra':{input:assertPatchedDiscreteTetraInput,handshake:assertPatchedDiscreteTetraHandshake,result:assertPatchedDiscreteTetraResult,failure:patchedDiscreteTetraFailure}}),
});
export class DiscreteTetraClient extends SingleJobNativeClient{
  constructor(options){super({...options,profile});}
  tetrahedralize(input,{sourceInput,signal}={}){return this.execute('mesh.discrete-tetra',normalizeDiscreteTetraInput(input),{signal,context:{sourceInput}});}
  tetrahedralizeConstrained(input,{sourceInput,signal}={}){return this.execute('mesh.discrete-constrained-tetra',normalizeDiscreteTetraInput(input),{signal,context:{sourceInput}});}
  tetrahedralizePatched(input,{sourceInput,signal}={}){return this.execute('mesh.discrete-patched-tetra',normalizeDiscreteTetraInput(input),{signal,context:{sourceInput}});}
}
