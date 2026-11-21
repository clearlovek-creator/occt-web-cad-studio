import {spawn} from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import {childExit,waitChildExit} from './child-exit.mjs';
import {BoundedJsonLines} from './bounded-json-lines.mjs';

export class MeshWorkerError extends Error {
  constructor(code,message,options={}) {super(message);this.name="MeshWorkerError";this.code=code;this.retryable=options.retryable===true;}
}

/** Each pending request belongs to one exact child, never to a FIFO position. */
export class MeshWorkerClient {
  constructor({workerPath,runtimePath="",timeoutMs=120_000,cwd=path.dirname(workerPath),spawnImpl=spawn,maxFrameBytes=64*1024*1024,maxRequestBytes=16*1024*1024,exitError=code=>new MeshWorkerError("MESH_WORKER_EXITED","Mesh worker exited with code "+code+".",{retryable:true}),environment={}}) {
    if(!Number.isSafeInteger(maxRequestBytes)||maxRequestBytes<1)throw new Error('Invalid mesh request budget');
    Object.assign(this,{workerPath,runtimePath,timeoutMs,cwd,spawnImpl,maxFrameBytes,maxRequestBytes,exitError,environment:{...environment}});this.worker=undefined;this.frames=new BoundedJsonLines(maxFrameBytes);this.pending=new Map();this.children=new Set();this.disposed=false;
  }
  isReady() {return Boolean(this.worker && !this.worker.killed && this.worker.stdin?.writable);}
  fork() {if(this.disposed)throw new MeshWorkerError('MESH_WORKER_CLOSED','网格服务已停止，不能派生新的工作进程。');return new MeshWorkerClient({workerPath:this.workerPath,runtimePath:this.runtimePath,timeoutMs:this.timeoutMs,cwd:this.cwd,spawnImpl:this.spawnImpl,maxFrameBytes:this.maxFrameBytes,maxRequestBytes:this.maxRequestBytes,exitError:this.exitError,environment:this.environment});}
  start() {
    if(this.disposed)throw new MeshWorkerError('MESH_WORKER_CLOSED','网格服务已停止，不能启动新的工作进程。');
    if(this.isReady())return this.worker;
    this.frames.clear();
    const environment={...process.env,...this.environment},inherited=environment.Path||environment.PATH||"";
    delete environment.Path;delete environment.PATH;
    environment.Path=[this.runtimePath,inherited].filter(Boolean).join(path.delimiter);
    const child=this.spawnImpl(this.workerPath,[],{cwd:this.cwd,env:environment,stdio:["pipe","pipe","pipe"],windowsHide:true});
    this.worker=child;
    this.children.add(child);void childExit(child).then(()=>this.children.delete(child));
    child.stdout.on("data",chunk=>{if(this.worker===child)this.consume(child,chunk);});
    child.stderr.setEncoding("utf8");child.stderr.on("data",chunk=>process.stderr.write("[gmsh] "+chunk));
    child.once("error",error=>this.failChild(child,new MeshWorkerError("MESH_WORKER_START_FAILED",error.message,{retryable:true})));
    child.stdin.on("error",error=>this.failChild(child,new MeshWorkerError("MESH_WORKER_WRITE_FAILED",error.message,{retryable:true})));
    child.once("exit",code=>this.failChild(child,this.exitError(code)));
    return child;
  }
  request(input) {
    if(this.disposed)return Promise.reject(new MeshWorkerError('MESH_WORKER_CLOSED','网格服务已停止，未执行请求。'));
    const requestId=String(input.requestId||crypto.randomUUID());
    if(this.pending.has(requestId))return Promise.reject(new MeshWorkerError("MESH_DUPLICATE_REQUEST","A mesh request with this ID is already running."));
    let payload;
    try{payload=JSON.stringify({...input,requestId});}catch{return Promise.reject(new MeshWorkerError('MESH_REQUEST_INVALID','网格请求不能序列化。'));}
    if(Buffer.byteLength(payload)>this.maxRequestBytes)return Promise.reject(new MeshWorkerError('MESH_REQUEST_LIMIT','网格请求超过传输预算，未启动工作进程。'));
    return new Promise((resolve,reject)=>{
      let child;
      try{child=this.start();}catch(error){reject(new MeshWorkerError("MESH_WORKER_START_FAILED",error.message));return;}
      if(!this.isReady()){reject(new MeshWorkerError("MESH_WORKER_UNAVAILABLE","Mesh worker is unavailable.",{retryable:true}));return;}
      const entry={child,resolve:value=>{clearTimeout(entry.timer);this.pending.delete(requestId);resolve(value);},
        reject:error=>{clearTimeout(entry.timer);this.pending.delete(requestId);reject(error);},timer:null};
      entry.timer=setTimeout(()=>this.failChild(child,new MeshWorkerError("MESH_WORKER_TIMEOUT","Mesh worker did not respond within "+this.timeoutMs+" ms.",{retryable:true})),this.timeoutMs);
      this.pending.set(requestId,entry);
      child.stdin.write(payload+"\n",error=>{
        if(error && this.pending.get(requestId)===entry)this.failChild(child,new MeshWorkerError("MESH_WORKER_WRITE_FAILED",error.message,{retryable:true}));
      });
    });
  }
  consume(child,chunk) {
    try{this.frames.push(chunk,line=>{
      if(this.worker!==child)return false;
      if(!line.trim())return;
      let response;
      try{response=JSON.parse(line);}catch(error){this.failChild(child,new MeshWorkerError("MESH_WORKER_INVALID_RESPONSE",error.message));return false;}
      const entry=this.pending.get(String(response.requestId||""));
      if(!entry || entry.child!==child){this.failChild(child,new MeshWorkerError("MESH_WORKER_PROTOCOL_ERROR","Mesh response does not match an active request."));return false;}
      if(response.ok===false)entry.reject(new MeshWorkerError(response.code||"GMSH_FAILURE",response.error||"Gmsh operation failed."));
      else entry.resolve(response);
    });}catch(error){this.failChild(child,new MeshWorkerError(error.code==='MCP_FRAME_LIMIT'?'MESH_WORKER_RESPONSE_LIMIT':'MESH_WORKER_INVALID_RESPONSE',error.code==='MCP_FRAME_LIMIT'?'网格回复超过传输预算，已停止读取。':'网格回复不是合法 UTF-8 JSON。'));}
  }
  failChild(child,error) {
    if(this.worker===child){this.worker=undefined;this.frames.clear();}
    for(const entry of [...this.pending.values()])if(entry.child===child)entry.reject(error);
    if(child && !child.killed)child.kill();
  }
  close() {
    for(const child of this.children)this.failChild(child,new MeshWorkerError("MESH_WORKER_CLOSED","Mesh worker was closed."));
  }
  async closeAndWait() {
    const children=[...this.children];
    this.close();
    await Promise.all(children.map(child=>waitChildExit(child,{code:'MESH_WORKER_STOP_TIMEOUT',message:'网格工作进程尚未确认退出。'})));
  }
  dispose(){this.disposed=true;return this.closeAndWait();}
}
