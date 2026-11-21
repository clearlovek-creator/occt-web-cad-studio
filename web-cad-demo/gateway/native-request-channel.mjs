import {waitChildExit,childExit} from './child-exit.mjs';
import {BoundedJsonLines} from './bounded-json-lines.mjs';

export class NativeChannelError extends Error {
  constructor(code,message){super(message);this.name='NativeChannelError';this.code=code;this.retryableByModel=false;}
}

/** One process generation. No reply, timer or write callback crosses generations. */
export class NativeRequestChannel {
  constructor(child,{timeoutMs=15000,stopTimeoutMs=5000,maxResponseBytes=256*1024*1024,maxRequestBytes=4*1024*1024,maxPendingBytes=16*1024*1024,maxPendingRequests=64,drainSuccessfulExit=false,drainFailureExitCodes=[],onUnavailable=()=>{},onStopped=()=>{},onDiagnostic=()=>{},exitError=(code)=>new NativeChannelError('WORKER_UNAVAILABLE',`Geometry worker exited with code ${code}.`)}={}){
    for(const value of [timeoutMs,stopTimeoutMs,maxResponseBytes,maxRequestBytes,maxPendingBytes,maxPendingRequests])if(!Number.isSafeInteger(value)||value<1)throw new TypeError('Native channel limits must be positive safe integers.');
    Object.assign(this,{child,timeoutMs,stopTimeoutMs,maxResponseBytes,maxRequestBytes,maxPendingBytes,maxPendingRequests,onUnavailable,onStopped,onDiagnostic,exitError});
    if(typeof drainSuccessfulExit!=='boolean')throw new TypeError('Output drain mode must be explicit.');
    if(!Array.isArray(drainFailureExitCodes)||drainFailureExitCodes.some(code=>!Number.isSafeInteger(code)||code<1||code>255||[86,87,88,89].includes(code))||new Set(drainFailureExitCodes).size!==drainFailureExitCodes.length)throw new TypeError('Failure output drain requires explicit non-resource exit codes.');
    this.drainFailureExitCodes=new Set(drainFailureExitCodes);
    this.drainSuccessfulExit=drainSuccessfulExit;this.outputDrain=null;this.outputDrainFinish=null;this.outputEnded=false;this.outputFramingComplete=false;this.outputEndedNormally=false;
    this.state='active';this.pending=new Map();this.pendingBytes=0;this.frames=new BoundedJsonLines(maxResponseBytes);this.retirement=null;this.failure=null;this.stoppedNotified=false;
    child.stdout.on('data',chunk=>this.receive(chunk));
    child.stdout.on('error',error=>{void this.retire(new NativeChannelError('WORKER_UNAVAILABLE','几何输出通道错误：'+error.message));});
    child.stdout.once('end',()=>{
      this.outputEnded=true;this.outputFramingComplete=this.frames.bytes===0;
      if(this.state==='active'){
        this.outputEndedNormally=this.outputFramingComplete;
        const boundedDrain=this.drainSuccessfulExit||this.drainFailureExitCodes.size>0;
        void this.retire(new NativeChannelError(boundedDrain&&!this.outputFramingComplete?'WORKER_PROTOCOL_ERROR':'WORKER_UNAVAILABLE',boundedDrain&&!this.outputFramingComplete?'单任务输出含未结束的尾部，未接纳结果。':'几何输出通道已关闭。'),{observeExitFirst:true});
      }
    });
    child.stdin?.on('error',error=>{void this.retire(new NativeChannelError('WORKER_UNAVAILABLE','几何输入通道错误：'+error.message));});
    child.stderr?.on('error',error=>{void this.retire(new NativeChannelError('WORKER_UNAVAILABLE','几何诊断通道错误：'+error.message));});
    child.on('error',error=>{void this.retire(new NativeChannelError('WORKER_UNAVAILABLE',error.message));});
    child.once('exit',code=>{if(this.state==='active'){if((this.drainSuccessfulExit&&code===0||this.drainFailureExitCodes.has(code))&&!this.outputEnded)this.beginOutputDrain();else void this.retire(this.exitError(code));}});
    // childExit attaches before a kill request and also handles failed spawn.
    this.exitObserved=childExit(child);
  }
  status(){return {state:this.state,pendingRequests:this.pending.size,pendingBytes:this.pendingBytes,responseBufferedBytes:this.frames.bytes,maxPendingRequests:this.maxPendingRequests,maxPendingBytes:this.maxPendingBytes,maxRequestBytes:this.maxRequestBytes,timeoutMs:this.timeoutMs,stopTimeoutMs:this.stopTimeoutMs};}
  settle(id,error,value){
    const entry=this.pending.get(id);if(!entry)return;
    this.pending.delete(id);this.pendingBytes-=entry.bytes;clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);
    if(error)entry.reject(error);else entry.resolve(value);
  }
  rejectAfterRetirement(){
    // Pipe closure can precede the authoritative Windows exit reason. New
    // callers must not publish that provisional failure while old calls wait.
    return (this.outputDrain||this.retirement||Promise.resolve()).then(()=>{throw this.failure||new NativeChannelError('WORKER_UNAVAILABLE','几何进程正在停止，未发送请求。');});
  }
  request(command,{signal,timeoutMs=this.timeoutMs}={}){
    if(signal?.aborted)return Promise.reject(new NativeChannelError('WORKER_CANCELLED','几何请求尚未发送，已取消。'));
    if(this.state!=='active')return this.rejectAfterRetirement();
    if(!this.child.stdin?.writable||this.child.killed||this.child.exitCode!=null||this.child.signalCode!=null){if(!this.outputDrain)void this.retire(new NativeChannelError('WORKER_UNAVAILABLE','几何进程不可写，等待退出确认。'));return this.rejectAfterRetirement();}
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)return Promise.reject(new NativeChannelError('WORKER_REQUEST_INVALID','几何请求时限无效。'));
    const id=command?.requestId;
    if(typeof id!=='string'||!id||id.length>256||this.pending.has(id))return Promise.reject(new NativeChannelError('WORKER_REQUEST_INVALID','几何请求缺少唯一的关联标识。'));
    let wire;try{wire=JSON.stringify(command)+'\n';}catch{return Promise.reject(new NativeChannelError('WORKER_REQUEST_INVALID','几何请求无法序列化，未发送。'));}
    const bytes=Buffer.byteLength(wire);
    if(bytes>this.maxRequestBytes)return Promise.reject(new NativeChannelError('WORKER_REQUEST_TOO_LARGE','几何请求超过单次输入预算，未发送。'));
    if(this.pending.size>=this.maxPendingRequests||this.pendingBytes+bytes>this.maxPendingBytes)return Promise.reject(new NativeChannelError('WORKER_QUEUE_LIMIT','几何后台排队预算已满，未发送请求；请等待当前任务完成。'));
    return new Promise((resolve,reject)=>{
      const fail=(code,message)=>{void this.retire(new NativeChannelError(code,message));};
      const entry={resolve,reject,bytes,documentId:command.documentId,operation:command.operation,signal,abort:()=>fail('WORKER_CANCELLED','几何请求已中断；已确认原进程退出后才会开始工程恢复。')};
      entry.timer=setTimeout(()=>fail('WORKER_TIMEOUT',`Geometry worker did not respond within ${timeoutMs} ms.`),timeoutMs);
      this.pending.set(id,entry);this.pendingBytes+=bytes;signal?.addEventListener('abort',entry.abort,{once:true});
      if(signal?.aborted){this.settle(id,new NativeChannelError('WORKER_CANCELLED','几何请求尚未发送，已取消。'));return;}
      // A partial write cannot be removed independently: the native line
      // framing may already be damaged, so retire the whole exact generation.
      try{this.child.stdin.write(wire,error=>{if(error&&this.pending.get(id)===entry)fail('WORKER_UNAVAILABLE','几何请求写入失败：'+error.message);});}
      catch(error){fail('WORKER_UNAVAILABLE','几何请求写入失败：'+error.message);}
    });
  }
  receive(chunk){
    if(this.state!=='active')return;
    try{this.frames.push(chunk,source=>{
      if(this.state!=='active')return false;
      const line=source.trim();if(!line)return;
      if(!line.startsWith('{')){this.onDiagnostic(line);return;}
      let value;try{value=JSON.parse(line);}catch{void this.retire(new NativeChannelError('WORKER_PROTOCOL_ERROR','几何后台返回了无效 JSON，未将后续回复分配给其他请求。'));return false;}
      const entry=this.pending.get(value?.requestId);
      if(!entry||value.protocolVersion!==1||typeof value.ok!=='boolean'||value.ok&&entry.documentId&&entry.operation!=='health.ping'&&value.documentId!==entry.documentId){
        void this.retire(new NativeChannelError('WORKER_PROTOCOL_ERROR','几何回复的关联标识、协议或工程身份不匹配；未采用该回复。'));return false;
      }
      this.settle(value.requestId,null,value);
    });}catch(error){
      void this.retire(error.code==='MCP_FRAME_LIMIT'
        ?new NativeChannelError('WORKER_RESPONSE_TOO_LARGE',`Geometry worker response exceeded the ${Math.round(this.maxResponseBytes/1024/1024)} MB limit. Request a body presentation instead of a whole-document mesh.`)
        :new NativeChannelError('WORKER_PROTOCOL_ERROR','几何后台回复不是合法的 UTF-8 JSON，未采用替代字符或后续错位回复。'));
    }
  }
  async waitUntilStopped(){
    if(this.outputDrain)await this.outputDrain;
    if(this.state==='closed')return;
    if(this.state==='active')return;
    await this.retirement;
    if(this.state!=='closed')throw new NativeChannelError('WORKER_STOP_UNCONFIRMED','尚未确认原几何进程退出；未启动替代进程或发送恢复请求。');
  }
  beginOutputDrain(){
    if(this.outputDrain)return;
    let resolveDrain,timer,finishing=false;
    this.outputDrain=new Promise(resolve=>resolveDrain=resolve);
    const finish=reason=>{
      if(finishing)return;finishing=true;clearTimeout(timer);
      this.child.stdout.off('end',ended);this.child.stdout.off('close',closed);
      if(this.state==='active')void this.retire(reason||new NativeChannelError('WORKER_PROTOCOL_ERROR','单任务进程已退出，但输出没有完整结束；未接纳结果。'));
      void (this.retirement||Promise.resolve()).then(()=>{this.outputDrainFinish=null;resolveDrain();});
    };
    const ended=()=>finish(),closed=()=>finish(new NativeChannelError('WORKER_PROTOCOL_ERROR','单任务输出在完整结束前关闭；未接纳结果。'));
    this.outputDrainFinish=()=>finish();
    this.child.stdout.once('end',ended);this.child.stdout.once('close',closed);
    timer=setTimeout(()=>finish(new NativeChannelError('WORKER_PROTOCOL_ERROR','单任务进程已退出，但输出收尾超过时限；未接纳结果。')),this.stopTimeoutMs);
  }
  retire(error,{observeExitFirst=false}={}){
    if(this.retirement)return this.retirement;
    this.failure=error;this.state='retiring';this.frames.clear();
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);}
    this.onUnavailable(error);
    const observed=()=>{
      this.state='closed';
      let finalError=error;
      // stdout EOF may precede the OS exit event. Preserve an authoritative
      // resource exit reason instead of reporting it as a generic pipe close.
      if(error.code==='WORKER_UNAVAILABLE'){
        const exited=this.exitError(this.child.exitCode);
        if(exited.code!=='WORKER_UNAVAILABLE')finalError=exited;
      }
      this.failure=finalError;
      // Make replacement/recovery possible before rejecting the old calls.
      if(!this.stoppedNotified){this.stoppedNotified=true;this.onStopped(finalError);}
      for(const id of [...this.pending.keys()])this.settle(id,finalError);
    };
    const stopped=waitChildExit(this.child,{timeoutMs:this.stopTimeoutMs,code:'WORKER_STOP_UNCONFIRMED',message:'尚未确认原几何进程退出，已阻止恢复和替代进程。'});
    const stop=()=>{if(this.child.exitCode==null&&this.child.signalCode==null)try{this.child.kill();}catch{/* actual exit remains authoritative */}};
    this.retirement=stopped.then(observed,reason=>{
      this.state='blocked';this.failure=new NativeChannelError(reason.code,reason.message);
      for(const id of [...this.pending.keys()])this.settle(id,this.failure);
      stop();
      // A stop deadline is not an exit. Only the original observed handle can
      // later unblock this generation; no restart is scheduled on timeout.
      void this.exitObserved.then(observed);
    });
    if(this.outputDrainFinish){const finish=this.outputDrainFinish;void this.retirement.then(finish);}
    // EOF is often the first observable part of a native self-termination.
    // Killing it here can overwrite its real Windows exit code with SIGTERM.
    // Observe until the stop deadline, then request stop but keep it blocked.
    if(!observeExitFirst)stop();
    return this.retirement;
  }
}
