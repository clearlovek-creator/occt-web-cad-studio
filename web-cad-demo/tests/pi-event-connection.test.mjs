import test from 'node:test';
import assert from 'node:assert/strict';
import {tsImport} from '../../pi/node_modules/tsx/dist/esm/api/index.mjs';
import {fileURLToPath} from 'node:url';
const {PiEventConnection}=await tsImport('../app/modeling/pi-event-connection.ts',{parentURL:import.meta.url,tsconfig:fileURLToPath(new URL('../tsconfig.json',import.meta.url))});
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Condition did not become true');};
const deferred=()=>{let resolve;const promise=new Promise(a=>resolve=a);return {promise,resolve};};
test('a saved unknown owner confirmation requires recovery before any native session startup',async()=>{const bindings=[];let calls=0;const connection=new PiEventConnection({apiRoot:'/api',sessionId:'legacy',documentId:'doc',ownershipPending:true,fetchImpl:async()=>{calls++;throw Error('must not start');},onOwnershipRequired:value=>bindings.push(value),onStatus:()=>{},onNotice:()=>{},onSnapshot:()=>{},onEvent:()=>{}});try{await connection.open();assert.equal(calls,0);assert.deepEqual(bindings,[{sessionId:'legacy',documentId:'doc'}]);}finally{connection.close();}});
test('legacy owner rejection exposes one exact recovery binding without automatic attribution or retry',async()=>{
  const bindings=[],calls=[];const connection=new PiEventConnection({apiRoot:'/api',sessionId:'legacy',documentId:'doc',fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({ok:false,code:'PI_SESSION_OWNER_REQUIRED',error:'review required'}),{status:428});},onOwnershipRequired:value=>bindings.push(value),onStatus:()=>{},onNotice:()=>{},onSnapshot:()=>{},onEvent:()=>{}});try{await connection.open();await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(bindings,[{sessionId:'legacy',documentId:'doc'}]);assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].init.body).command,undefined);}finally{connection.close();}
});
function fixture({gate,initial=0,postCursor,delayRead=false,compactGate,returnedSessionId='session'}={}){
  const state={streamId:A,sequence:initial,messages:[],streaming:false},commands=[],sources=[],statuses=[],snapshots=[],events=[],notices=[],signals=[];let posts=0,synchronized=0;
  const packet=(response,cursor=state.sequence)=>({ok:true,documentId:'doc',streamId:state.streamId,eventCursor:cursor,response:{success:true,data:response}});
  const fetchImpl=async(_url,options)=>{
    const input=JSON.parse(options.body);let payload;
    if(!input.command){posts++;payload={ok:true,sessionId:returnedSessionId,documentId:'doc',streamId:state.streamId,eventCursor:postCursor??state.sequence};}
    else{commands.push(input.command);const type=input.command.type;const data=type==='get_messages'?{messages:structuredClone(state.messages)}:type==='get_state'?{isStreaming:state.streaming}:type==='get_available_models'?{models:[]}:type==='get_available_thinking_levels'?{levels:['off']}:{};payload=packet(data);if(type==='get_messages'&&gate&&(posts===1||delayRead))await gate.promise;if(type==='compact'&&compactGate){signals.push(options.signal);await compactGate.promise;}}
    return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const eventSource=url=>{const query=new URL(url).searchParams,streamId=query.get('streamId'),listeners=new Map();const source={onopen:null,onerror:null,closed:false,addEventListener:(name,callback)=>listeners.set(name,callback),close(){this.closed=true;},emit(event){listeners.get('pi')?.({data:JSON.stringify(event)});}};sources.push(source);setTimeout(()=>{if(source.closed)return;source.onopen?.();source.emit({type:'stream_connected',streamId,documentId:'doc',after:Number(query.get('after'))});},0);return source;};
  const connection=new PiEventConnection({apiRoot:'http://test/api',sessionId:'session',documentId:'doc',fetchImpl,eventSource,retryDelays:[0,0,0],onStatus:phase=>statuses.push(phase),onSnapshot:value=>snapshots.push(value),onEvent:event=>events.push(event),onNotice:value=>notices.push(value),onSynchronized:()=>{synchronized++;}});
  const emit=(type,extra={},cursor=++state.sequence)=>sources.at(-1).emit({type,...extra,documentId:'doc',streamId:state.streamId,eventCursor:cursor});
  return {state,commands,sources,statuses,snapshots,events,notices,signals,connection,emit,get posts(){return posts;},get synchronized(){return synchronized;}};
}

test('a native compaction receives its own browser receipt budget, not the short query deadline',async t=>{
  const compactGate=deferred(),f=fixture({compactGate});try{
    await f.connection.open();await wait(()=>f.statuses.at(-1)==='online');t.mock.timers.enable({apis:['setTimeout']});
    const compacting=f.connection.request({type:'compact'});assert.equal(f.signals.length,1);t.mock.timers.tick(45000);assert.equal(f.signals[0].aborted,false,'A legitimate compaction must not be aborted at the old 40-second query deadline');compactGate.resolve();await compacting;assert.equal(f.posts,1);assert.equal(f.commands.filter(command=>command.type==='compact').length,1);
  }finally{compactGate.resolve();f.connection.close();t.mock.timers.reset();}
});
test('connection binding is immutable and reflects the actual server session, not a later preference cache',async()=>{
  const f=fixture({returnedSessionId:'actual-session'});try{const first=f.connection.getBinding();assert.deepEqual(first,{sessionId:'session',documentId:'doc'});assert.equal(Object.isFrozen(first),true);assert.throws(()=>{first.sessionId='foreign';});await f.connection.open();await wait(()=>f.statuses.at(-1)==='online');assert.deepEqual(f.connection.getBinding(),{sessionId:'actual-session',documentId:'doc'});assert.equal(first.sessionId,'session');}finally{f.connection.close();}
});

test('each initial, manual and network connection reconciles geometry once, never on ordinary history refresh',async()=>{
  const f=fixture();try{
    await f.connection.open();await wait(()=>f.synchronized===1);
    await f.connection.refresh();await wait(()=>f.statuses.at(-1)==='online');
    assert.equal(f.synchronized,1,'History refresh must not repeatedly reload geometry');
    f.emit('runtime_exit',{signal:'SIGTERM'});assert.equal(f.statuses.at(-1),'interrupted');
    f.state.streamId=B;f.state.sequence=0;
    await f.connection.open();await wait(()=>f.synchronized===2);
    f.sources.at(-1).onerror();await wait(()=>f.synchronized===3);
    assert.equal(f.commands.some(command=>['prompt','steer','follow_up'].includes(command.type)),false);
  }finally{f.connection.close();}
});

test('large native events synchronize their full snapshot on the same stream without repeating prompts or resetting context',async()=>{
  const f=fixture();try{
    await f.connection.open();await wait(()=>f.statuses.at(-1)==='online');
    f.state.messages=[{role:'toolResult',toolCallId:'large',content:[{type:'text',text:'full native output'}]}];
    f.emit('runtime_snapshot_required',{nativeEventType:'tool_execution_end',toolCallId:'large',toolName:'primitive__box'});
    await wait(()=>f.snapshots.at(-1)?.messages?.[0]?.toolCallId==='large'&&f.statuses.at(-1)==='online');
    assert.equal(f.posts,1);assert.equal(f.sources.length,1);assert.equal(f.synchronized,1);assert.ok(f.events.some(event=>event.type==='runtime_snapshot_required'&&event.toolCallId==='large'));
    assert.equal(f.commands.some(command=>['prompt','steer','follow_up'].includes(command.type)),false);
  }finally{f.connection.close();}
});

test('tool results already covered by a native history snapshot still deliver one small CAD reconciliation hint',async()=>{
  const f=fixture();try{
    await f.connection.open();await wait(()=>f.statuses.at(-1)==='online');
    f.state.sequence=1;f.state.messages=[{role:'toolResult',toolCallId:'covered',toolName:'body__delete',content:[{type:'text',text:'full result'}]}];
    const reading=f.connection.refresh();f.emit('tool_execution_end',{toolCallId:'covered',toolName:'body__delete',result:{content:[{type:'text',text:'do not replay UI payload'}]}},1);
    await reading;await wait(()=>f.statuses.at(-1)==='online');
    const hints=f.events.filter(event=>event.type==='runtime_snapshot_required');assert.equal(hints.length,1);assert.equal(hints[0].toolCallId,'covered');assert.equal(hints[0].toolName,'body__delete');assert.doesNotMatch(JSON.stringify(hints),/do not replay/);assert.equal(f.posts,1);
  }finally{f.connection.close();}
});

test('a network reconnect changes generation and resynchronizes native history without resending a prompt',async()=>{
  const f=fixture({initial:500});try{await f.connection.open();await wait(()=>f.statuses.at(-1)==='online');await f.connection.request({type:'prompt',message:'build once'});f.state.messages=[{role:'user',content:'build once'}];f.state.streamId=B;f.state.sequence=0;f.sources[0].onerror();await wait(()=>f.posts===2&&f.statuses.at(-1)==='online');assert.equal(f.commands.filter(item=>item.type==='prompt').length,1);assert.deepEqual(f.snapshots.at(-1).messages,f.state.messages);f.emit('tool_execution_end',{toolCallId:'new-tool'});assert.equal(f.events.at(-1).toolCallId,'new-tool');assert.ok(f.sources[0].closed);}finally{f.connection.close();}
});
test('history and status have independent snapshot watermarks; late event delivery cannot overwrite newer snapshots',async()=>{
  const gate=deferred(),f=fixture({gate});try{const opening=f.connection.open();await wait(()=>f.commands.some(item=>item.type==='get_messages'));f.state.streaming=true;f.emit('agent_start');f.emit('message_update',{assistantMessageEvent:{type:'text_delta',delta:'new text'}});gate.resolve();await opening;await wait(()=>f.statuses.at(-1)==='online');assert.equal(f.snapshots.at(-1).state.isStreaming,true);assert.deepEqual(f.events.map(event=>event.type),['message_update']);}finally{gate.resolve();f.connection.close();}
  const delayed=fixture({initial:2,postCursor:0});try{delayed.state.messages=[{role:'assistant',content:'already up to date'}];const opening=delayed.connection.open();await wait(()=>delayed.commands.some(item=>item.type==='get_available_thinking_levels'));assert.notEqual(delayed.statuses.at(-1),'online','Snapshot readiness alone must not skip the SSE catch-up barrier');delayed.emit('message_update',{old:true},1);delayed.emit('message_update',{old:true},2);await opening;await wait(()=>delayed.statuses.at(-1)==='online');delayed.emit('message_update',{new:true},3);assert.equal(delayed.events.length,1);assert.equal(delayed.events[0].new,true);}finally{delayed.connection.close();}
});
test('a native process exit invalidates late HTTP state and never automatically restarts the task',async()=>{
  const gate=deferred(),f=fixture({gate});try{const opening=f.connection.open();await wait(()=>f.commands.length===2);f.emit('runtime_exit',{signal:'SIGTERM'});assert.equal(f.statuses.at(-1),'interrupted');f.state.streaming=true;gate.resolve();await opening;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.snapshots.length,0);assert.equal(f.posts,1);assert.equal(f.commands.some(item=>item.type==='prompt'),false);f.sources[0].onopen?.();assert.equal(f.statuses.at(-1),'interrupted');}finally{gate.resolve();f.connection.close();}
});
test('an event gap closes the obsolete source and recovers by read-only snapshots',async()=>{
  const f=fixture();try{await f.connection.open();await wait(()=>f.statuses.at(-1)==='online');f.state.sequence=2;f.emit('message_update',{gap:true},2);await wait(()=>f.posts===2&&f.statuses.at(-1)==='online');assert.equal(f.events.some(event=>event.gap),false);assert.equal(f.commands.some(item=>['prompt','steer','follow_up'].includes(item.type)),false);assert.equal(f.sources[0].closed,true);}finally{f.connection.close();}
});
test('closing a connection cannot publish delayed snapshot data to its former project',async()=>{
  const gate=deferred(),f=fixture({gate});try{const opening=f.connection.open();await wait(()=>f.commands.length===2);f.connection.close();gate.resolve();await opening;assert.equal(f.snapshots.length,0);assert.equal(f.sources[0].closed,true);assert.equal(f.commands.some(item=>item.type==='abort'),false);}finally{gate.resolve();f.connection.close();}
});
