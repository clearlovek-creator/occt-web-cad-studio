import crypto from 'node:crypto';
import {MeshWorkerClient,MeshWorkerError} from './mesh-worker-client.mjs';
import {meshMemoryPolicy,assertNativeMemoryGuard,meshResourceExitError} from './native-resource-policy.mjs';
import {waitChildExit} from './child-exit.mjs';

/** Production mesh transport. No modeling input is sent before this exact
 * child proves its OS-enforced cap; no new child overlaps an unretired one. */
export class GuardedMeshWorkerClient extends MeshWorkerClient {
  constructor({memoryPolicy=meshMemoryPolicy(),...options}){
    const policy=meshMemoryPolicy({MESH_WORKER_MEMORY_LIMIT_BYTES:String(memoryPolicy.limitBytes)});
    super({...options,environment:{...options.environment,MESH_WORKER_MEMORY_LIMIT_BYTES:String(policy.limitBytes)},exitError:code=>meshResourceExitError(code,policy)});
    this.memoryPolicy=Object.freeze(policy);this.readying=null;this.proof=null;this.blocked=null;this.generation=0;
  }
  fork(){if(this.disposed)throw new MeshWorkerError('MESH_WORKER_CLOSED','网格服务已停止，不能派生新的工作进程。');return new GuardedMeshWorkerClient({workerPath:this.workerPath,runtimePath:this.runtimePath,timeoutMs:this.timeoutMs,cwd:this.cwd,spawnImpl:this.spawnImpl,maxFrameBytes:this.maxFrameBytes,maxRequestBytes:this.maxRequestBytes,memoryPolicy:this.memoryPolicy,environment:this.environment});}
  resourceStatus(){const alive=[...this.children].filter(child=>child.exitCode==null&&child.signalCode==null);return {basis:this.memoryPolicy.basis,configuredBytes:this.memoryPolicy.limitBytes,state:this.blocked?'blocked':this.proof&&this.worker===this.proof.child&&!this.worker.killed?'enforced':alive.length?'pending':'idle',liveProcesses:alive.length,blockedCode:this.blocked?.code||null};}
  failChild(child,error){if(this.proof?.child===child)this.proof=null;if(error.permanent)this.blocked=error;super.failChild(child,error);}
  close(){this.generation++;super.close();}
  async ensureGuard(){
    if(this.disposed)throw new MeshWorkerError('MESH_WORKER_CLOSED','网格服务已停止。');if(this.blocked)throw this.blocked;
    if(this.proof&&this.proof.child===this.worker&&this.isReady())return this.proof;
    if(this.readying)return this.readying;
    const generation=this.generation;
    const work=(async()=>{
      if(!this.worker&&this.children.size)await Promise.all([...this.children].map(child=>waitChildExit(child,{code:'MESH_STOP_UNCONFIRMED',message:'旧网格进程尚未核验退出，未启动重叠进程。'})));
      if(this.disposed||generation!==this.generation)throw new MeshWorkerError('MESH_WORKER_CLOSED','网格启动已停止。');
      const child=this.start();
      try{
        const health=await super.request({protocolVersion:1,requestId:'mesh-resource-'+crypto.randomUUID(),operation:'health.ping'});
        if(this.disposed||generation!==this.generation||this.worker!==child||!this.isReady())throw new MeshWorkerError('MESH_WORKER_CLOSED','资源握手所属网格进程已停止。');
        const resource=assertNativeMemoryGuard(health,this.memoryPolicy,'gmsh-mesh-worker');this.proof={child,resource};return this.proof;
      }catch(error){this.failChild(child,error);await waitChildExit(child,{code:'MESH_STOP_UNCONFIRMED',message:'网格资源握手失败，进程尚未核验退出；未无保护继续。'});if([86,87,88,89].includes(child.exitCode)){const cause=meshResourceExitError(child.exitCode,this.memoryPolicy);if(cause.permanent)this.blocked=cause;throw cause;}throw error;}
    })();
    this.readying=work;try{return await work;}finally{if(this.readying===work)this.readying=null;}
  }
  async request(input){
    // Preserve the transport's admission-before-start invariant.
    if(!input||typeof input!=='object'||Array.isArray(input))throw new MeshWorkerError('MESH_REQUEST_INVALID','网格请求必须为对象。');
    const command={...input,requestId:String(input.requestId||crypto.randomUUID())};
    let payload;try{payload=JSON.stringify(command);}catch{throw new MeshWorkerError('MESH_REQUEST_INVALID','网格请求不能序列化。');}
    if(Buffer.byteLength(payload)>this.maxRequestBytes)throw new MeshWorkerError('MESH_REQUEST_LIMIT','网格请求超过传输预算，未启动工作进程。');
    const proof=await this.ensureGuard();
    if(this.worker!==proof.child||!this.isReady())throw new MeshWorkerError('MESH_WORKER_UNAVAILABLE','已核对的网格进程不再可用，未重发命令。');
    try{const result=await super.request(command);return {...result,processResources:{...proof.resource}};}
    catch(error){if(this.worker!==proof.child||proof.child.killed||proof.child.exitCode!=null){await waitChildExit(proof.child,{code:'MESH_STOP_UNCONFIRMED',message:'网格任务中断后尚未核验进程退出，未启动替代进程。'});if([86,87,88,89].includes(proof.child.exitCode))throw meshResourceExitError(proof.child.exitCode,this.memoryPolicy);}throw error;}
  }
}
