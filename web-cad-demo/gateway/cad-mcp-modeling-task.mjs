import {randomUUID} from 'node:crypto';
import {normalizeModelingTaskStatus} from '../shared/modeling-task-status.mjs';

export class CadMcpTaskError extends Error {
  constructor(code,message,{outcome='unknown',task,requestId,retryableByModel=false,fieldPath,selectionPaths}={}) {
    super(message);this.code=code;this.outcome=outcome;this.modelingTask=task;this.requestId=requestId;this.retryableByModel=retryableByModel;
    if(typeof fieldPath==='string'&&fieldPath.length<=256)this.fieldPath=fieldPath;
    if(Array.isArray(selectionPaths)&&selectionPaths.length<=32&&selectionPaths.every(value=>typeof value==='string'&&value.length<=256))this.selectionPaths=selectionPaths;
  }
}
const jsonHeaders={'Content-Type':'application/json'};

/** Observation deadlines never authorize replay or prove that native work stopped. */
async function json(fetchImpl,url,init,timeoutMs,limitBytes=32*1024*1024) {
  const controller=new AbortController();let reader,expired=false,timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;controller.abort();reject(Error('CAD task observation expired'));},timeoutMs);});
  const observe=promise=>Promise.race([promise,deadline]);
  try {
    const work=Promise.resolve().then(()=>fetchImpl(url,{...init,redirect:'error',signal:controller.signal}));
    void work.then(response=>{if(expired)void response.body?.cancel().catch(()=>{});},()=>{});
    const response=await observe(work),length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limitBytes))throw Error('CAD task response length invalid');
    reader=response.body?.getReader();if(!reader)throw Error('CAD task response empty');
    const chunks=[];let bytes=0,fragments=0;
    for(;;) {
      const {done,value}=await observe(reader.read());if(done)break;
      bytes+=value.byteLength;if(bytes>limitBytes||++fragments>100000)throw Error('CAD task response budget exceeded');
      chunks.push(value);if(fragments%64===0)await observe(new Promise(resolve=>setImmediate(resolve)));
    }
    const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
    if(!payload||Array.isArray(payload)||typeof payload.ok!=='boolean')throw Error('CAD task response invalid');
    return {response,payload};
  } finally {
    clearTimeout(timer);controller.abort();if(reader)void reader.cancel().catch(()=>{});
  }
}

/** One registration and at most one command submission. Cancellation is a separate task control. */
export async function executeMcpModelingTask({root,command,fetchImpl=fetch,signal,controlMs=5000,commandMs=150000,pollMs=250}) {
  const encoded=JSON.stringify({...command,requestId:randomUUID()}),input=JSON.parse(encoded),documentId=input.documentId,operation=input.operation;
  const collection=`${root}/documents/${encodeURIComponent(documentId)}/modeling-tasks`;
  let task,finished=false,cancelling;
  const error=(code,message,outcome='unknown')=>new CadMcpTaskError(code,message,{outcome,task,requestId:input.requestId});
  const accept=value=>{
    const next=normalizeModelingTaskStatus(value,documentId,task?.taskId);
    if(next.operation!==operation||next.requestKey!==input.requestId)throw Error('CAD task binding mismatch');
    if(!task||next.sequence>=task.sequence)task=next;
    return task;
  };
  const route=suffix=>collection+'/'+task.taskId+suffix;
  const status=async()=>{const packet=await json(fetchImpl,route(''),undefined,controlMs,65536);if(!packet.response.ok||packet.payload.ok!==true)throw Error('CAD task status unavailable');return accept(packet.payload.modelingTask);};
  const cancel=()=>{
    if(!task||finished||cancelling)return cancelling;
    cancelling=(async()=>{
      for(;;) {
        if(finished)return;
        const observed=await status();if(finished)return;
        if(['succeeded','failed','cancelled','unknown'].includes(observed.phase))return;
        if(observed.cancellable) {
          const packet=await json(fetchImpl,route('/cancel'),{method:'POST',headers:jsonHeaders,body:'{}'},controlMs,65536);
          if(packet.response.ok&&packet.payload.ok===true)accept(packet.payload.modelingTask);
          // A race into protected commit or a lost acknowledgement never authorizes another POST.
          return;
        }
        if(['committing','stopping','rolling-back'].includes(observed.phase))return;
        await new Promise(resolve=>setTimeout(resolve,pollMs));
      }
    })().catch(()=>{});
    return cancelling;
  };
  const terminalError=()=>{
    const notStarted=task?.execution==='not-started',restored=task?.restored===true;
    if(task?.phase==='cancelled'&&(notStarted||restored))return error(notStarted?'MCP_CANCELLED_BEFORE_EXECUTION':'WORKER_CANCELLED',notStarted?'建模任务已取消，几何命令未执行。':'建模任务已取消，原几何、属性与历史已恢复。',notStarted?'not-started':'restored');
    return error(task?.code||'MCP_TASK_RESULT_UNCONFIRMED',task?.error||'建模结果尚未确认，请核对原任务；不会自动重新执行。',notStarted?'not-started':restored?'restored':'unknown');
  };
  const success=payload=>{
    // Native requestId can describe a later document.view used to assemble the
    // committed view. The durable task's requestKey is the caller identity.
    if(payload?.ok!==true||payload.documentId!==documentId||task.phase!=='succeeded'||!Number.isSafeInteger(task.revision)||payload.revision!==task.revision||!/^[a-f0-9]{64}$/.test(task.stateToken||'')||payload.stateToken!==task.stateToken)throw Error('CAD task receipt mismatch');
    return {...payload,modelingTask:task};
  };
  const recover=async()=>{
    await status();if(task.phase!=='succeeded')throw terminalError();
    const packet=await json(fetchImpl,route('/result'),undefined,controlMs);
    if(!packet.response.ok||packet.payload.ok!==true)throw Error('CAD task receipt unavailable');
    return success(packet.payload.result);
  };
  if(signal?.aborted)throw error('MCP_CANCELLED_BEFORE_SEND','工具调用在发送前已取消，未登记或执行。','not-started');
  const stopped=()=>{void cancel();};signal?.addEventListener('abort',stopped,{once:true});
  try {
    let reservation;
    try {reservation=await json(fetchImpl,collection,{method:'POST',headers:jsonHeaders,body:JSON.stringify({command:input})},controlMs,65536);}
    catch {throw error('MCP_TASK_REGISTRATION_UNCONFIRMED','任务登记结果尚未确认，几何命令未发送；请检查任务记录，不会改用直发或重试。','not-started');}
    if(!reservation.response.ok||reservation.payload.ok!==true)throw new CadMcpTaskError(reservation.payload.code||'MCP_TASK_REGISTRATION_FAILED',String(reservation.payload.error||'当前后台未接收建模任务，未发送几何命令。').slice(0,1000),{outcome:'not-started',requestId:input.requestId,retryableByModel:!signal?.aborted&&reservation.payload.retryableByModel===true,fieldPath:reservation.payload.fieldPath,selectionPaths:reservation.payload.selectionPaths});
    try {accept(reservation.payload.modelingTask);if(task.phase!=='reserved'||task.reportDurable!==true)throw Error('CAD task not reserved');}
    catch {throw error('MCP_TASK_REGISTRATION_UNCONFIRMED','任务登记凭据与原请求不符，未发送几何命令。','not-started');}
    if(signal?.aborted) {
      await cancel();
      if(task.phase==='cancelled')throw terminalError();
      throw error('MCP_CANCELLED_BEFORE_SEND','停止已请求，几何命令未发送；原登记任务的取消状态请另行核对。','not-started');
    }
    let packet;
    try {packet=await json(fetchImpl,root+'/commands',{method:'POST',headers:{...jsonHeaders,'X-Cad-Task-Id':task.taskId},body:encoded},commandMs);}
    catch {
      try {return await recover();}catch(cause){if(cause instanceof CadMcpTaskError)throw cause;throw error('MCP_TASK_RESULT_UNCONFIRMED','命令回复未确认，原任务或回执暂不可读；不会重新发送几何命令。');}
    }
    try {accept(packet.payload.modelingTask);}catch {throw error('MCP_TASK_RESULT_UNCONFIRMED','几何回复未携带可信原任务身份，结果需核对；不会重发。');}
    if(packet.response.ok&&packet.payload.ok===true) {
      try {return success(packet.payload);}catch {throw error('MCP_TASK_RESULT_UNCONFIRMED','提交回执与原工程或请求不符，请核对原任务。');}
    }
    throw terminalError();
  } finally {
    finished=true;signal?.removeEventListener('abort',stopped);await cancelling;
    // No retry of registration, command or cancellation, including a lost cancel reply.
  }
}
