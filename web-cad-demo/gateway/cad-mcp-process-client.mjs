import {spawn} from 'node:child_process';
import {waitChildExit,childExit} from './child-exit.mjs';
import {BoundedJsonLines} from './bounded-json-lines.mjs';
import {backendChildArgs,backendChildEnvironment} from './backend-runtime.mjs';

export const MCP_PROCESS_LIMITS=Object.freeze({requestBytes:2*1024*1024,responseBytes:32*1024*1024,queueBytes:4*1024*1024,queueCount:32,stderrBytes:64*1024,timeoutMs:180000,stopMs:5000});
export class McpProcessError extends Error{
  constructor(code,message,{outcome='not-started'}={}){super(message);this.name='McpProcessError';this.code=code;this.outcome=outcome;this.retryableByModel=false;}
}
const unknown=code=>new McpProcessError(code,'CAD 工具已发送但没有取得可信终态，几何可能已经提交；禁止重发，请先查询工程核对结果。',{outcome:'unknown'});

/** One bounded, observed subprocess. Cancelling a sent atomic CAD call is not rollback. */
export class CadMcpProcessClient{
  constructor({serverPath,apiRoot,documentId,cwd=process.cwd(),spawnImpl=spawn,limits={},onDiagnostic=()=>{}}){
    if(!serverPath)throw new McpProcessError('MCP_PATH_REQUIRED','CAD MCP 程序路径未配置。');
    this.limits={...MCP_PROCESS_LIMITS,...limits};for(const value of Object.values(this.limits))if(!Number.isSafeInteger(value)||value<1)throw new McpProcessError('MCP_INVALID_LIMIT','MCP 预算必须是正整数。');
    this.queue=[];this.queueBytes=0;this.active=null;this.sequence=0;this.state='open';this.reconcileRequired=false;this.stderrBytes=0;this.frames=new BoundedJsonLines(this.limits.responseBytes);
    this.child=spawnImpl(process.execPath,[...backendChildArgs(),serverPath],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...backendChildEnvironment(),CAD_MCP_SERVER_PATH:serverPath,CAD_GEOMETRY_API_URL:apiRoot||'http://127.0.0.1:8788/api',CAD_DOCUMENT_ID:documentId||'default',CAD_AGENT_MODE:'edit'}});
    this.closed=new Promise(resolve=>this.child.once('close',()=>{this.finishExit();resolve();}));
    this.exited=childExit(this.child);this.exited.then(()=>{if(this.state==='open'){this.state='closing';this.rejectQueued('MCP_PROCESS_EXIT');}});
    this.child.stdout.on('data',chunk=>this.receive(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
    this.child.stdout.on('error',()=>this.fail('MCP_STDOUT_ERROR'));
    this.child.stderr.on('data',chunk=>{this.stderrBytes+=Buffer.byteLength(chunk);if(this.stderrBytes>this.limits.stderrBytes)this.fail('MCP_STDERR_LIMIT');else onDiagnostic('CAD MCP diagnostic output received.');});
    this.child.once('error',()=>this.fail('MCP_PROCESS_ERROR'));
    this.child.stderr.on('error',()=>this.fail('MCP_STDERR_ERROR'));
    this.child.stdin.on('error',()=>this.fail('MCP_STDIN_ERROR'));
  }
  status(){return {state:this.state,queued:this.queue.length,queuedBytes:this.queueBytes,inFlight:Boolean(this.active),reconcileRequired:this.reconcileRequired,exited:this.child.exitCode!=null||this.child.signalCode!=null};}
  request(method,params={},options={}){
    if(this.state!=='open')return Promise.reject(new McpProcessError('MCP_NOT_RUNNING','CAD 工具连接不可用，请恢复原会话并查询工程；不会重发旧命令。'));
    if(this.reconcileRequired&&!options.readOnly)return Promise.reject(new McpProcessError('MCP_RECONCILE_REQUIRED','上一次工具结果未知；请先 query_model 核对工程，再重新决定后续修改。'));
    if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1))return Promise.reject(new McpProcessError('MCP_INVALID_TIMEOUT','工具截止时间必须是正整数。'));
    if(options.signal?.aborted)return Promise.reject(new McpProcessError('MCP_CANCELLED_BEFORE_SEND','命令在发送前已取消，未执行。'));
    let line;try{line=JSON.stringify({jsonrpc:'2.0',id:`mcp-${++this.sequence}`,method,params})+'\n';}catch{return Promise.reject(new McpProcessError('MCP_INVALID_REQUEST','工具请求无法编码。'));}
    const bytes=Buffer.byteLength(line);
    if(bytes>this.limits.requestBytes)return Promise.reject(new McpProcessError('MCP_REQUEST_LIMIT','工具请求超过大小预算，未发送。'));
    if(this.queue.length+(this.active?1:0)>=this.limits.queueCount||this.queueBytes+bytes>this.limits.queueBytes)return Promise.reject(new McpProcessError('MCP_QUEUE_LIMIT','CAD 工具队列已满，命令未发送。'));
    return new Promise((resolve,reject)=>{
      const entry={id:`mcp-${this.sequence}`,line,bytes,method,options,resolve,reject,sent:false,settled:false};
      entry.cancel=()=>{
        if(entry.sent){entry.cancelRequested=true;if(entry.options.readOnly){this.settle(entry,new McpProcessError('MCP_READ_CANCELLED','只读查询已取消，几何未改变。',{outcome:'unchanged'}));return;}
          try{this.notify('notifications/cancelled',{requestId:entry.id,reason:'User requested cancellation'});}catch{/* The original call remains observed; a failed control write is not rollback. */}
          try{options.onProgress?.('已请求取消当前建模任务；正在等待内核停止与工程恢复核对。提交阶段受保护，不能保证本次仍可取消。');}catch{/* Presentation failure cannot cancel or replay an atomic request. */}return;}
        this.removeQueued(entry);this.settle(entry,new McpProcessError('MCP_CANCELLED_BEFORE_SEND','排队命令已撤回，未执行。'));
      };
      options.signal?.addEventListener('abort',entry.cancel,{once:true});
      entry.timer=setTimeout(()=>{
        if(entry.sent){if(!entry.options.readOnly)this.reconcileRequired=true;this.settle(entry,entry.options.readOnly?new McpProcessError('MCP_READ_TIMEOUT','只读工具等待超时。',{outcome:'unchanged'}):unknown('MCP_CALL_TIMEOUT'));this.rejectQueued('MCP_RECONCILE_REQUIRED');}
        else{this.removeQueued(entry);this.settle(entry,new McpProcessError('MCP_QUEUE_TIMEOUT','工具在队列中超时，未发送。'));}
      },options.timeoutMs??this.limits.timeoutMs);
      this.queue.push(entry);this.queueBytes+=bytes;this.pump();
    });
  }
  notify(method,params={}){
    if(this.state!=='open')throw new McpProcessError('MCP_NOT_RUNNING','CAD MCP 已停止。');
    const line=JSON.stringify({jsonrpc:'2.0',method,params})+'\n';if(Buffer.byteLength(line)>this.limits.requestBytes)throw new McpProcessError('MCP_REQUEST_LIMIT','MCP 通知超过预算。');
    if((this.child.stdin.writableLength||0)+Buffer.byteLength(line)>this.limits.queueBytes)throw new McpProcessError('MCP_QUEUE_LIMIT','MCP 通知发送队列已满。');
    this.child.stdin.write(line,error=>{if(error)this.fail('MCP_STDIN_ERROR');});
  }
  removeQueued(entry){const index=this.queue.indexOf(entry);if(index>=0){this.queue.splice(index,1);this.queueBytes-=entry.bytes;}}
  settle(entry,error,result){if(entry.settled)return;entry.settled=true;clearTimeout(entry.timer);entry.options.signal?.removeEventListener('abort',entry.cancel);if(error)entry.reject(error);else entry.resolve(result);}
  rejectQueued(code){for(const entry of this.queue)this.settle(entry,new McpProcessError(code,'排队工具未执行；请恢复连接并重新核对工程。'));this.queue=[];this.queueBytes=0;}
  pump(){
    if(this.state!=='open'||this.active||!this.queue.length)return;
    const entry=this.queue.shift();this.queueBytes-=entry.bytes;
    if(entry.options.signal?.aborted){this.settle(entry,new McpProcessError('MCP_CANCELLED_BEFORE_SEND','发送前取消，未执行。'));this.pump();return;}
    this.active=entry;entry.sent=true;
    this.child.stdin.write(entry.line,error=>{if(error)this.fail('MCP_STDIN_ERROR');});
  }
  receive(chunk){
    if(this.state==='closed'||this.state==='failed')return;
    try{this.frames.push(chunk,line=>{
      if(!line)return;
      let message;try{message=JSON.parse(line);}catch{this.fail('MCP_INVALID_RESPONSE');return false;}
      if(!message||typeof message!=='object'||Array.isArray(message)||message.jsonrpc!=='2.0'||!this.active||message.id!==this.active.id||Boolean(Object.hasOwn(message,'result'))===Boolean(Object.hasOwn(message,'error'))||(Object.hasOwn(message,'error')&&(!message.error||typeof message.error!=='object'||!Number.isInteger(message.error.code)||typeof message.error.message!=='string'||message.error.message.length>1024))){this.fail('MCP_INVALID_RESPONSE');return false;}
      const entry=this.active;this.active=null;
      if(message.error){const outcome=entry.options.readOnly?'unchanged':message.error.data?.outcome==='not-started'?'not-started':'unknown';if(outcome==='unknown'){this.reconcileRequired=true;this.rejectQueued('MCP_RECONCILE_REQUIRED');}this.settle(entry,new McpProcessError('MCP_RPC_ERROR',String(message.error.message||'MCP 请求被拒绝。'),{outcome}));}
      else this.settle(entry,null,message.result);
      this.pump();
      return this.state!=='failed';
    });}catch(error){this.fail(error.code==='MCP_FRAME_LIMIT'?'MCP_RESPONSE_LIMIT':'MCP_INVALID_RESPONSE');}
  }
  confirmReconciled(){if(this.state==='open'&&!this.active)this.reconcileRequired=false;}
  requireReconciliation(){this.reconcileRequired=true;}
  fail(code){
    if(['failed','closed'].includes(this.state))return;this.state='failed';this.frames.clear();
    if(this.active){this.reconcileRequired=true;this.settle(this.active,this.active.options.readOnly?new McpProcessError(code,'只读工具连接中断。',{outcome:'unchanged'}):unknown(code));}
    this.rejectQueued(code);this.child.stdin.end();
  }
  finishExit(){
    if(this.active){this.settle(this.active,this.active.options.readOnly?new McpProcessError('MCP_PROCESS_EXIT','只读工具进程已退出。',{outcome:'unchanged'}):unknown('MCP_PROCESS_EXIT'));this.active=null;}
    this.rejectQueued('MCP_PROCESS_EXIT');this.frames.clear();this.state='closed';
  }
  async stop(){
    if(this.state==='closed')return;
    if(this.stopping)return this.stopping;
    this.stopping=(async()=>{
      if(this.state==='open')this.state='closing';this.rejectQueued('MCP_STOPPED_BEFORE_SEND');this.child.stdin.end();
      try{await waitChildExit(this.child,{timeoutMs:this.limits.stopMs});}
      catch{
        // This terminates only the HTTP tool bridge, never the CAD kernel.
        // An already dispatched mutation remains unknown, not rolled back.
        if(this.active&&!this.active.settled)this.settle(this.active,this.active.options.readOnly?new McpProcessError('MCP_STOPPED','只读工具已停止。',{outcome:'unchanged'}):unknown('MCP_STOPPED_UNKNOWN'));
        this.child.kill();
        await waitChildExit(this.child,{timeoutMs:this.limits.stopMs,code:'MCP_STOP_UNCONFIRMED',message:'CAD MCP 进程尚未核验退出；保留原进程观察，不启动替代进程。'});
      }
      let timer;try{await Promise.race([this.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new McpProcessError('MCP_STDIO_CLOSE_UNCONFIRMED','MCP 进程已退出但通道尚未关闭，保留原观察。')),this.limits.stopMs);})]);}finally{clearTimeout(timer);}
    })();
    try{return await this.stopping;}finally{this.stopping=null;}
  }
}
