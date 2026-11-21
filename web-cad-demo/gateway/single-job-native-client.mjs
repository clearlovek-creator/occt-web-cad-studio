import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {NativeRequestChannel,NativeChannelError} from './native-request-channel.mjs';
import {childExit,waitChildExit} from './child-exit.mjs';
import {assertNativeMemoryGuard} from './native-resource-policy.mjs';
import {discreteValidationBinary,assertDiscreteValidationReceipt} from './discrete-validation-envelope.mjs';

function mapped(error,profile){
  if(!error?.code?.startsWith('WORKER_'))return error;
  const names={WORKER_CANCELLED:'CANCELLED',WORKER_TIMEOUT:'TIMEOUT',WORKER_STOP_UNCONFIRMED:'STOP_UNCONFIRMED',WORKER_UNAVAILABLE:'PROCESS_UNAVAILABLE',WORKER_PROTOCOL_ERROR:'PROTOCOL_INVALID',WORKER_RESPONSE_TOO_LARGE:'OUTPUT_LIMIT',WORKER_REQUEST_TOO_LARGE:'INPUT_LIMIT'};
  const code=profile.prefix+(names[error.code]||'TRANSPORT_FAILED');
  return profile.fault(code,profile.label+'通道未完成核验：'+code+'；没有接纳结果或自动重发。');
}
function nativeEnvironment(source,profile,runtimePath,memoryLimitBytes){
  const env={};
  for(const name of ['SystemRoot','WINDIR','TEMP','TMP','SYSTEMDRIVE']){const key=Object.keys(source).find(key=>key.toLowerCase()===name.toLowerCase());if(key!==undefined&&typeof source[key]==='string')env[name]=source[key];}
  return {...env,Path:runtimePath,[profile.memoryVariable]:String(memoryLimitBytes)};
}

// Shared lifecycle extracted from DiscreteSurfaceClient. Geometry algorithms
// supply a closed operation registry, validators and resource policy only.
export class SingleJobNativeClient{
  constructor({profile,workerPath,runtimePath=path.dirname(workerPath),cwd=path.dirname(workerPath),environment={},memoryLimitBytes,timeoutMs=120000,handshakeTimeoutMs=10000,stopTimeoutMs=5000,spawnImpl=spawn,validate}){
    for(const [value,max]of [[timeoutMs,1800000],[handshakeTimeoutMs,60000],[stopTimeoutMs,30000]])if(!Number.isSafeInteger(value)||value<1||value>max)throw TypeError('Invalid single-job native deadline.');
    const memoryPolicy=profile.memoryPolicy({...process.env,...environment,...(memoryLimitBytes===undefined?{}:{[profile.memoryVariable]:String(memoryLimitBytes)})});
    if(validate!==undefined&&typeof validate!=='function')throw TypeError('Invalid native validation boundary.');
    Object.assign(this,{profile,workerPath:path.resolve(workerPath),runtimePath:path.resolve(runtimePath),cwd:path.resolve(cwd),environment:{...environment},memoryPolicy,timeoutMs,handshakeTimeoutMs,stopTimeoutMs,spawnImpl,validate});
    this.active=null;this.closed=false;this.children=new Set();
  }
  status(){return {state:this.closed?'closed':this.active?.state||'idle',liveProcesses:this.children.size,memoryLimitBytes:this.memoryPolicy.limitBytes,oneJobPerProcess:true,automaticReplay:false};}
  resourceStatus(){return {basis:this.memoryPolicy.basis,configuredBytes:this.memoryPolicy.limitBytes,state:this.active?.state||'idle',liveProcesses:this.children.size};}
  dispose(){return this.closeAndWait();}
  async execute(operation,input,{signal,context}={}){
    const p=this.profile,fault=(name,message)=>p.fault(p.prefix+name,p.label+message),spec=p.operations[operation];
    if(!spec)throw fault('REQUEST_INVALID','不支持该操作。');
    if(this.closed)throw fault('SERVICE_CLOSED','服务已停止。');
    if(this.active)throw fault('BUSY','上一个任务或进程尚未退出；未开始第二个任务。');
    if(signal?.aborted)throw fault('CANCELLED','尚未开始，已取消。');
    const requestId=p.requestPrefix+crypto.randomUUID();let command;
    try{const wire=JSON.stringify({protocolVersion:1,requestId,operation,input});if(Buffer.byteLength(wire+'\n')>p.maxRequestBytes)throw fault('INPUT_LIMIT','输入超过传输预算，未启动进程。');command=JSON.parse(wire);}
    catch(error){if(error?.code?.startsWith(p.prefix))throw error;throw fault('REQUEST_INVALID','输入不能序列化，未启动进程。');}
    const owner={state:'starting',child:null,channel:null,validationController:new AbortController()};this.active=owner;
    const validationSignal=signal?AbortSignal.any([signal,owner.validationController.signal]):owner.validationController.signal;
    const checkpoint=()=>{if(signal?.aborted)throw fault('CANCELLED','校验期间已取消，未采用迟到材料。');if(this.closed)throw fault('SERVICE_CLOSED','校验期间服务已停止。');};
    const fatalChannelError=error=>['WORKER_PROTOCOL_ERROR','WORKER_RESPONSE_TOO_LARGE',p.prefix+'PROTOCOL_INVALID',p.prefix+'DIAGNOSTIC_LIMIT'].includes(error?.code);
    const failValidation=error=>{if(owner.validation){if(!owner.validationExitError||/_(MEMORY_LIMIT|MEMORY_EXHAUSTED|RESOURCE_GUARD_UNAVAILABLE|RESOURCE_CONFIG_INVALID)$/.test(error.code||''))owner.validationExitError=error;owner.validationController.abort();}};
    const validate=async(phase,candidate)=>{
      const {packet,sha256}=discreteValidationBinary({phase,operation,requestId,input:command.input,...context!==undefined&&{context},...candidate!==undefined&&{candidate}});
      owner.state='validating-'+phase;
      const pending=owner.validation=Promise.resolve().then(()=>this.validate(packet,{signal:validationSignal}));
      try{const receipt=await pending;if(owner.validationExitError)throw owner.validationExitError;checkpoint();return assertDiscreteValidationReceipt(receipt,packet,sha256);}catch(error){if(owner.validationExitError)throw owner.validationExitError;checkpoint();throw error;}finally{if(owner.validation===pending)owner.validation=null;}
    };
    try{
      if(this.validate){if(context!==undefined){const wire=JSON.stringify(context);if(Buffer.byteLength(wire)>p.maxRequestBytes)throw fault('INPUT_LIMIT','校验上下文超过输入预算。');context=JSON.parse(wire);}await validate('input');checkpoint();owner.state='starting';}
      else spec.input(command.input,context);
      const env=nativeEnvironment({...process.env,...this.environment},p,this.runtimePath,this.memoryPolicy.limitBytes);
      const child=owner.child=this.spawnImpl(this.workerPath,[...(p.args||[])],{cwd:this.cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
      this.children.add(child);const exited=childExit(child);void exited.then(()=>{this.children.delete(child);if(this.active===owner&&owner.state==='blocked')this.active=null;});
      const channel=owner.channel=new NativeRequestChannel(child,{timeoutMs:this.timeoutMs,stopTimeoutMs:this.stopTimeoutMs,maxRequestBytes:p.maxRequestBytes,maxResponseBytes:p.maxResponseBytes,maxPendingBytes:p.maxRequestBytes,maxPendingRequests:1,drainSuccessfulExit:true,drainFailureExitCodes:[2],exitError:code=>p.resourceExit(code,this.memoryPolicy),onUnavailable:error=>{if(fatalChannelError(error))failValidation(error);},onDiagnostic:()=>{void channel.retire(fault('PROTOCOL_INVALID','标准输出包含非协议内容，未接纳结果。'));}});
      child.once('exit',code=>{if(owner.validation&&code!==owner.expectedExitCode)failValidation([86,87,88,89].includes(code)?p.resourceExit(code,this.memoryPolicy):fault('PROCESS_FAILED','校验期间进程异常退出，未接纳回复。'));});
      let diagnosticBytes=0;child.stderr.on('data',chunk=>{diagnosticBytes+=chunk.length;if(diagnosticBytes>65536)void channel.retire(fault('DIAGNOSTIC_LIMIT','诊断超出 64 KiB，已停止；未接纳结果。'));});
      const failure=response=>{
        if(response.service!==p.service||typeof response.code!=='string'||!/^[A-Z][A-Z0-9_]{1,79}$/.test(response.code)||typeof response.error!=='string')throw fault('PROTOCOL_INVALID','错误回复缺少准确的服务身份或错误类型。');
        return spec.failure?.(response,command.input,context)||p.fault(response.code,response.error.slice(0,1024)||p.label+'失败。');
      };
      const health=await channel.request({protocolVersion:1,requestId:'health-'+crypto.randomUUID(),operation:'health.ping'},{signal,timeoutMs:this.handshakeTimeoutMs});
      if(health.ok!==true)throw failure(health);
      const algorithm=spec.handshake(health),resources=assertNativeMemoryGuard(health,this.memoryPolicy,p.service);
      if(signal?.aborted)throw fault('CANCELLED','已取消，未发送几何。');
      owner.state='running';const result=await channel.request(command,{signal});
      owner.expectedExitCode=result.ok===true?0:2;
      if(this.validate&&fatalChannelError(channel.failure))throw channel.failure;
      if(this.validate&&child.exitCode!=null&&child.exitCode!==owner.expectedExitCode)throw [86,87,88,89].includes(child.exitCode)?p.resourceExit(child.exitCode,this.memoryPolicy):fault('PROCESS_FAILED','进程退出状态与回复不一致。');
      // Domain refusals (including strict quality rejection) are structured
      // results too. Do not kill the process before its authoritative exit or
      // let a truncated error masquerade as an engineering diagnosis.
      let semanticFailure=null;
      if(this.validate){const receipt=await validate(result.ok===true?'result':'failure',result);if(receipt.failure)semanticFailure=Object.assign(p.fault(receipt.failure.code,receipt.failure.message),receipt.failure.details===undefined?{}:{details:receipt.failure.details});}
      else{semanticFailure=result.ok===true?null:failure(result);if(!semanticFailure)spec.result(result,command.input,requestId,context);}
      owner.state='awaiting-exit';
      await waitChildExit(child,{timeoutMs:this.stopTimeoutMs,code:p.prefix+'STOP_UNCONFIRMED',message:p.label+'已回复但进程尚未核验退出；未接纳结果。'});
      if(signal?.aborted)throw fault('CANCELLED','已取消；未接纳迟到结果。');
      if(child.exitCode!==(semanticFailure?2:0)||child.signalCode)throw [86,87,88,89].includes(child.exitCode)?p.resourceExit(child.exitCode,this.memoryPolicy):fault('PROCESS_FAILED','进程退出状态与回复不一致；已丢弃回复。');
      // EOF can precede the Windows exit event. Let the same channel finish
      // reconciling that provisional pipe-close reason with the observed exit.
      await channel.waitUntilStopped();
      // Only the transport's expected close notification is benign, and only
      // after a validated reply and this exact child's matching observed exit.
      const expectedClose=semanticFailure?p.resourceExit(2,this.memoryPolicy).code:p.closedChannelCode;
      if(channel.failure&&channel.failure.code!==expectedClose)throw channel.failure;
      if(!channel.outputEnded||!channel.outputFramingComplete||!channel.outputEndedNormally)throw fault('PROTOCOL_INVALID','输出未完整结束；未接纳结果。');
      if(signal?.aborted)throw fault('CANCELLED','已取消；未接纳输出收尾期间到达的结果。');
      const execution={basis:'single-process-exit-confirmed-v1',exitCode:child.exitCode,automaticReplay:false};
      if(semanticFailure)throw Object.assign(semanticFailure,{processResources:resources,algorithm,execution});
      return {...result,processResources:resources,algorithm,execution};
    }catch(error){
      if(owner.channel&&owner.child?.exitCode==null&&owner.child?.signalCode==null)await owner.channel.retire(error instanceof Error?error:new NativeChannelError('WORKER_UNAVAILABLE',p.label+'中断。'));
      if(owner.child&&owner.child.exitCode==null&&owner.child.signalCode==null&&this.children.has(owner.child))throw fault('STOP_UNCONFIRMED','进程尚未核验退出，已阻止新任务；未接纳结果。');
      if([86,87,88,89].includes(owner.child?.exitCode))throw p.resourceExit(owner.child.exitCode,this.memoryPolicy);
      throw mapped(error,p);
    }finally{
      if(!owner.child||owner.child.exitCode!=null||owner.child.signalCode!=null||!this.children.has(owner.child)){if(this.active===owner)this.active=null;}
      else owner.state='blocked';
    }
  }
  async closeAndWait(){
    this.closed=true;const owner=this.active,p=this.profile;
    owner?.validationController.abort();
    if(owner?.channel)await owner.channel.retire(p.fault(p.prefix+'SERVICE_CLOSED',p.label+'服务正在停止。'));
    if(owner?.child)await waitChildExit(owner.child,{timeoutMs:this.stopTimeoutMs,code:p.prefix+'STOP_UNCONFIRMED',message:p.label+'停止后仍未核验原进程退出。'});
    if(owner?.validation)await owner.validation.catch(()=>{});
  }
}
