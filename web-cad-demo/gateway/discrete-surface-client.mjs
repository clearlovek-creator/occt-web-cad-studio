import {SingleJobNativeClient} from './single-job-native-client.mjs';
import {discreteMemoryPolicy,discreteResourceExitError} from './native-resource-policy.mjs';
import {DISCRETE_SURFACE_PROTOCOL as P,DiscreteSurfaceError,assertDiscreteHandshake,assertDiscreteResult} from './discrete-surface-protocol.mjs';
import {assertVolumePartitionInput,assertVolumePartitionHandshake,assertVolumePartitionResult,assertConstrainedVolumeInput,assertConstrainedVolumeHandshake,assertConstrainedVolumeResult} from './volume-partition-protocol.mjs';

function surfaceInput(input){
  if(!input||Array.isArray(input)||typeof input!=='object'||!Array.isArray(input.triangles)||!input.triangles.length||input.triangles.length>P.maxInputTriangles||!Array.isArray(input.sources)||input.sources.length!==input.triangles.length)
    throw new DiscreteSurfaceError('SURFACE_REQUEST_INVALID','表面输入缺少有界三角形和逐三角形来源，未启动进程。');
}
const profile=Object.freeze({
  service:P.service,prefix:'SURFACE_',label:'离散表面重构',requestPrefix:'surface-',closedChannelCode:'WORKER_UNAVAILABLE',
  maxRequestBytes:P.maxRequestBytes,maxResponseBytes:P.maxResponseBytes,
  memoryVariable:'DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES',memoryPolicy:discreteMemoryPolicy,resourceExit:discreteResourceExitError,
  fault:(code,message)=>new DiscreteSurfaceError(code,message),
  operations:Object.freeze({
    'surface.refine':{input:surfaceInput,handshake:assertDiscreteHandshake,result:assertDiscreteResult},
    'volume.partition':{input:input=>{surfaceInput(input);assertVolumePartitionInput(input);},handshake:assertVolumePartitionHandshake,result:assertVolumePartitionResult},
    'volume.partition-constrained':{input:input=>{surfaceInput(input);assertConstrainedVolumeInput(input);},handshake:assertConstrainedVolumeHandshake,result:assertConstrainedVolumeResult},
  }),
});
export class DiscreteSurfaceClient extends SingleJobNativeClient{
  constructor(options){super({...options,profile});}
  refine(input,options={}){return this.execute('surface.refine',input,options);}
  partition(input,options={}){return this.execute('volume.partition',input,options);}
  partitionConstrained(input,options={}){return this.execute('volume.partition-constrained',input,options);}
  run(operation,input,options={}){return this.execute(operation,input,options);}
}
