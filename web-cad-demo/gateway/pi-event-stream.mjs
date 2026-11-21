const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sequence=value=>typeof value==='string'&&/^\d{1,16}$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
export function parsePiCursor({lastEventId,streamId,after}){
  if(lastEventId){const parts=String(lastEventId).split(':');if(parts.length===2)return uuid.test(parts[0])&&sequence(parts[1])!==null?{streamId:parts[0],after:sequence(parts[1])}:null;if(parts.length!==1)return null;after=parts[0];}
  return typeof streamId==='string'&&uuid.test(streamId)&&sequence(String(after??0))!==null?{streamId,after:sequence(String(after??0))}:null;
}
export function piReplayDecision(session,input){
  const cursor=parsePiCursor(input);
  if(!cursor)return {reset:true,reason:'unscoped-or-invalid-cursor',after:session.sequence};
  if(cursor.streamId!==session.streamId)return {reset:true,reason:'stream-changed',after:session.sequence};
  if(cursor.after>session.sequence)return {reset:true,reason:'cursor-ahead',after:session.sequence};
  const oldest=session.eventHistory[0]?.id??session.sequence+1;
  if(cursor.after<oldest-1)return {reset:true,reason:'replay-gap',after:session.sequence};
  return {reset:false,after:cursor.after};
}

/** Transport replay only. A reset asks clients to read native history, never replay prompts. */
export function attachPiEventStream(session,request,response,url,{origin,maxQueuedBytes=4*1024*1024}={}){
  const streamId=session.streamId,decision=piReplayDecision(session,{lastEventId:request.headers['last-event-id'],streamId:url.searchParams.get('streamId'),after:url.searchParams.get('after')});
  response.writeHead(200,{...origin,'Content-Type':'text/event-stream; charset=utf-8',Connection:'keep-alive','Cache-Control':'no-cache, no-transform'});response.flushHeaders?.();
  let lastId=decision.after,blocked=false,closed=false,queuedBytes=0;const queue=[];
  const cleanup=()=>{if(closed)return;closed=true;clearInterval(keepAlive);session.off('event',onEvent);session.off('removed',onRemoved);response.off('drain',drain);queue.length=0;queuedBytes=0;};
  const send=frame=>{if(closed)return;const bytes=Buffer.byteLength(frame);if(bytes>maxQueuedBytes||queuedBytes+bytes>maxQueuedBytes){cleanup();response.destroy();return;}if(blocked){queue.push({frame,bytes});queuedBytes+=bytes;}else blocked=!response.write(frame);};
  const drain=()=>{blocked=false;while(queue.length&&!blocked&&!closed){const item=queue.shift();queuedBytes-=item.bytes;blocked=!response.write(item.frame);}};
  const control=(type,extra={})=>send(`event: pi\ndata: ${JSON.stringify({type,streamId:session.streamId,eventCursor:session.sequence,sessionId:session.sessionId,documentId:session.documentId,...extra})}\n\n`);
  const onEvent=item=>{if(item.streamId!==streamId){control('stream_reset',{reason:'stream-changed'});return;}if(item.id<=lastId)return;send(`id: ${streamId}:${item.id}\nevent: pi\ndata: ${JSON.stringify({...item.event,streamId,eventCursor:item.id,sessionId:session.sessionId,documentId:session.documentId})}\n\n`);lastId=item.id;};
  const onRemoved=(details={})=>{control('runtime_exit',{reason:details.reason||'session-removed',error:details.reason==='service-shutdown'?'后台正在停止，Pi 会话已中断；恢复后请先核对工程，不会重发建模命令。':'Pi 会话已被关闭，可手动重新连接原生历史；不会重发命令。'});cleanup();response.end?.();};
  const keepAlive=setInterval(()=>{if(!blocked&&!closed)response.write(': keep-alive\n\n');},20000);
  response.on('drain',drain);response.on('close',cleanup);session.on('event',onEvent);session.on('removed',onRemoved);
  control(decision.reset?'stream_reset':'stream_connected',decision.reset?{reason:decision.reason}:{after:decision.after});
  if(!decision.reset)for(const item of session.eventHistory)if(item.id>lastId)onEvent(item);
  return cleanup;
}
