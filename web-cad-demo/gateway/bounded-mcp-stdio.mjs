import {BoundedJsonLines} from './bounded-json-lines.mjs';
export const MCP_STDIO_LIMITS=Object.freeze({requestBytes:2*1024*1024,responseBytes:32*1024*1024,queueBytes:4*1024*1024,queueCount:32,workMs:180000,recentIds:256});
/** Sequential, byte-bounded stdio. EOF/fault drains a dispatched CAD call; it is not rollback. */
export function serveBoundedMcp({stdin,stdout,handle,isReadOnly=message=>message.method!=='tools/call',limits={}}){
  const budget={...MCP_STDIO_LIMITS,...limits};for(const value of Object.values(budget))if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid MCP stdio budget');
  const frames=new BoundedJsonLines(budget.requestBytes),queue=[],ids=new Set();let bytes=0,active=null,closing=false,finished=false,pumping=false,fatal=null,resolveDone;
  const done=new Promise(resolve=>resolveDone=resolve);
  const rpcError=(id,code,message,outcome)=>({jsonrpc:'2.0',id:id??null,error:{code,message,data:{outcome,retryableByModel:false}}});
  const write=async response=>{
    if(!response)return;let line;
    try{line=JSON.stringify(response)+'\n';}catch{line=JSON.stringify(rpcError(response.id,-32603,'MCP response encoding failed','unknown'))+'\n';}
    if(Buffer.byteLength(line)>budget.responseBytes)line=JSON.stringify(rpcError(response.id,-32004,'MCP result exceeds byte budget; query the CAD document before deciding further edits',active&&isReadOnly(active.message)?'unchanged':'unknown'))+'\n';
    if(Buffer.byteLength(line)>budget.responseBytes)throw Error('MCP response budget is too small for a failure receipt');
    await new Promise((resolve,reject)=>stdout.write(line,error=>error?reject(error):resolve()));
  };
  const closeInput=(notice=null)=>{closing=true;if(!fatal)fatal=notice;frames.clear();stdin.pause();};
  const finish=()=>{if(finished)return;finished=true;stdin.off('data',receive);stdin.off('end',ended);stdin.destroy?.();stdout.end(()=>resolveDone());};
  const pump=async()=>{
    if(active||finished)return;
    if(closing){for(const item of queue.splice(0))await write(rpcError(item.message.id,-32002,'MCP stopped before this queued request was executed','not-started'));bytes=0;if(fatal)await write(fatal);finish();return;}
    const item=queue.shift();if(!item)return;bytes-=item.bytes;active=item;
    let timer;const work=Promise.resolve().then(()=>item.controller.signal.aborted?rpcError(item.message.id,-32800,'MCP request cancelled before execution','not-started'):handle(item.message,{signal:item.controller.signal}));
    try{
      const result=await Promise.race([work.then(response=>({response})),new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),budget.workMs);})]);
      if(result.timedOut){closeInput();await write(rpcError(item.message.id,-32001,'MCP deadline reached; the dispatched CAD call may still complete. Do not replay it.',isReadOnly(item.message)?'unchanged':'unknown'));await work.catch(()=>{});}
      else await write(result.response);
    }catch{closeInput();await write(rpcError(item.message.id,-32603,'MCP execution failed; verify CAD state before further edits',isReadOnly(item.message)?'unchanged':'unknown')).catch(()=>{});}
    finally{clearTimeout(timer);active=null;}
    await pump();
  };
  const kick=()=>{if(pumping||finished)return;pumping=true;void pump().catch(()=>{closing=true;queue.length=0;bytes=0;finish();}).finally(()=>{pumping=false;if(!finished&&(closing||queue.length))kick();});};
  const accept=line=>{
    if(!line)return true;let message;try{message=JSON.parse(line);}catch{closeInput(rpcError(null,-32700,'Invalid JSON frame','not-started'));return false;}
    const valid=message&&typeof message==='object'&&!Array.isArray(message)&&message.jsonrpc==='2.0'&&typeof message.method==='string';
    if(valid&&message.method.startsWith('notifications/')){
      if(message.method==='notifications/cancelled'&&!Object.hasOwn(message,'id')){
        const target=message.params?.requestId;
        if((typeof target==='string'&&target.length<=128)||Number.isSafeInteger(target)){
          if(active?.message.id===target)active.controller.abort();
          for(const item of queue)if(item.message.id===target)item.controller.abort();
        }
      }
      return true;
    }
    if(!valid||!((typeof message.id==='string'&&message.id.length<=128)||(Number.isSafeInteger(message.id)))){closeInput(rpcError(null,-32600,'Invalid MCP request identity','not-started'));return false;}
    const key=typeof message.id+':'+message.id;
    if(ids.has(key)){closeInput(rpcError(message.id,-32600,'Duplicate MCP request identity; it was not executed again','not-started'));return false;}
    const count=Buffer.byteLength(line);
    if(queue.length+(active?1:0)>=budget.queueCount||bytes+count>budget.queueBytes){closeInput(rpcError(message.id,-32002,'MCP input queue budget exceeded; request was not executed','not-started'));return false;}
    ids.add(key);while(ids.size>budget.recentIds)ids.delete(ids.values().next().value);
    queue.push({message,bytes:count,controller:new AbortController()});bytes+=count;kick();return true;
  };
  const receive=chunk=>{if(closing)return;try{frames.push(chunk,accept);}catch{closeInput(rpcError(null,-32003,'MCP input frame is invalid or exceeds byte budget','not-started'));}if(closing)kick();};
  const ended=()=>{if(!closing){try{frames.finish(accept);}catch{closeInput(rpcError(null,-32700,'Invalid final MCP frame','not-started'));}closing=true;}kick();};
  stdin.on('data',receive);stdin.once('end',ended);stdin.on('error',()=>{closeInput();kick();});stdout.on('error',()=>{closeInput();if(!active)finish();});
  return {done,status:()=>({closing,inFlight:Boolean(active),queued:queue.length,queuedBytes:bytes,frameBytes:frames.bytes}),close:()=>{closeInput();kick();return done;}};
}
