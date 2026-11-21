import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-pi-recovery-api-')),api='http://127.0.0.1:8904/api';let gateway,session;
async function start(){gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:'8904',GEOMETRY_DATA_DIR:data,GEOMETRY_JSON_LIMIT_BYTES:String(4*1024*1024),PI_CLI_PATH:path.join(root,'tests/fixtures/pi-rpc-fixture.mjs'),PI_CLI_CWD:root},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Pi recovery API gateway timeout')),15000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});}
async function stop(){
  if(!gateway)return;const old=gateway;gateway=null;
  if(old.exitCode!==null)return;
  // Windows kill() forcibly terminates the Gateway without waiting for Pi's
  // timers/stdio. Starting the replacement immediately can read a half-written
  // fixture history. Exercise the product's real awaited shutdown barrier.
  const control=JSON.parse(fs.readFileSync(path.join(data,'.gateway-control.json'),'utf8'));assert.equal(control.ownerPid,old.pid);
  const ended=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Pi fixture Gateway shutdown not confirmed; preserve '+data)),15000);old.once('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('Pi fixture Gateway shutdown '+code));});});
  const response=await fetch(api+'/runtime/shutdown',{method:'POST',headers:{'x-cad-shutdown-token':control.token},signal:AbortSignal.timeout(5000)});assert.equal(response.status,202);await ended;
}
before(start);after(async()=>{await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});});
async function post(route,body){return fetch(api+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)}).then(r=>r.json());}
const create=async()=>{const result=await post('/pi/sessions',{sessionId:'recovery',documentId:'default'});let failures=[];if(!result.ok){const directory=path.join(data,'pi-sessions/recovery');if(fs.existsSync(directory))failures=fs.readdirSync(directory).filter(file=>/^fixture-failure-\d+\.json$/.test(file)).slice(-16).map(file=>{const target=path.join(directory,file);return fs.statSync(target).size<=8192?JSON.parse(fs.readFileSync(target,'utf8')):{code:'FIXTURE_DIAGNOSTIC_LIMIT'};});}assert.equal(result.ok,true,JSON.stringify({result,fixtureFailures:failures}));assert.equal(typeof result.streamId,'string',JSON.stringify(result));return result;};
const rpc=(type,extra={})=>post('/pi/sessions/recovery/commands',{documentId:'default',streamId:session.streamId,command:{type,...extra}});
async function stream(query){const abort=new AbortController(),response=await fetch(api+'/pi/sessions/recovery/events?documentId=default&'+query,{signal:abort.signal});assert.equal(response.status,200,response.ok?'':await response.text());const reader=response.body.getReader();let text='';return {abort,async until(predicate){const timeout=setTimeout(()=>abort.abort(),8000);try{for(;;){const {done,value}=await reader.read();if(done)throw Error('SSE closed before expected event');text+=new TextDecoder().decode(value);if(predicate(text))return text;}}finally{clearTimeout(timeout);}}};}

test('real Gateway SSE resumes a new process generation despite a much larger cursor from the old Gateway',async()=>{
  session=await create();assert.equal(session.ok,true);const old=session.streamId;await rpc('prompt',{message:'fixture:pending'});await stop();await start();session=await create();assert.notEqual(session.streamId,old);const events=await stream(`streamId=${old}&after=9000`);try{const reset=await events.until(text=>text.includes('stream_reset'));assert.match(reset,/stream-changed/);await rpc('prompt',{message:'fixture:stream'});const output=await events.until(text=>text.includes('tool_execution_end'));assert.match(output,new RegExp(`id: ${session.streamId}:`));}finally{events.abort.abort();}
  const messages=await rpc('get_messages');assert.ok(messages.response.data.messages.some(message=>message.role==='user'&&message.content[0].text==='fixture:pending'));
  const log=fs.readFileSync(path.join(data,'pi-sessions/recovery/fixture-commands.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(log.filter(command=>command.type==='prompt'&&command.message==='fixture:pending').length,1,'A Gateway restart must not replay an accepted task');
});
test('stale and cross-project commands are rejected before the native RPC receives a write',async()=>{
  const failed=await post('/pi/sessions/recovery/commands',{streamId:'obsolete',documentId:'default',command:{type:'prompt',message:'must-not-run'}});assert.equal(failed.code,'PI_STREAM_CHANGED');const other=await post('/pi/sessions',{sessionId:'recovery',documentId:'other'});assert.equal(other.code,'PI_SESSION_DOCUMENT_MISMATCH');const log=fs.readFileSync(path.join(data,'pi-sessions/recovery/fixture-commands.jsonl'),'utf8');assert.equal(log.includes('must-not-run'),false);
});
test('RPC response watermarks exclude subsequent events delivered in the same stdout chunk',async()=>{
  await rpc('prompt',{message:'fixture:arm-race'});const snapshot=await rpc('get_messages');assert.equal(snapshot.ok,true);assert.equal(snapshot.response.data.messages.some(message=>message.content?.[0]?.text==='after snapshot response'),false);const events=await stream(`streamId=${session.streamId}&after=${snapshot.eventCursor}`);try{const replay=await events.until(text=>text.includes('after snapshot response'));assert.match(replay,/message_update/);}finally{events.abort.abort();}
});

test('RPC request/reply intervals retain an update emitted after snapshot capture but before its reply',async()=>{
  await rpc('prompt',{message:'fixture:arm-overlap'});const snapshot=await rpc('get_messages');assert.equal(snapshot.ok,true);assert.ok(snapshot.eventCursorBefore<snapshot.eventCursor);assert.equal(snapshot.response.data.messages.some(message=>message.content?.[0]?.text==='during snapshot reply'),false);
  const events=await stream(`streamId=${session.streamId}&after=${snapshot.eventCursorBefore}`);try{await events.until(text=>text.includes('during snapshot reply'));}finally{events.abort.abort();}
});
test('bounded replay gaps request a native-history sync rather than silently dropping events',async()=>{
  await rpc('prompt',{message:'fixture:burst'});
  // The prompt reply acknowledges receipt before the burst. A fixed 50 ms wait
  // can subscribe before eviction on a busy machine, in which case no replay
  // gap exists. This fixture emits the burst synchronously before handling the
  // next RPC: its history reply and watermark prove all 1200 updates arrived.
  const result=await rpc('get_messages');assert.ok(result.response.data.messages.some(message=>message.content?.some(part=>part.text==='burst-1199')));assert.ok(result.eventCursor>=1200);
  const events=await stream(`streamId=${session.streamId}&after=0`);try{const reset=await events.until(text=>text.includes('stream_reset'));assert.match(reset,/replay-gap/);}finally{events.abort.abort();}
});

test('large real-process tool results use small SSE hints but native history retains every byte without reconnecting the Pi generation',async()=>{
  const before=await rpc('get_messages'),events=await stream(`streamId=${session.streamId}&after=${before.eventCursor}`);
  try{
    await rpc('prompt',{message:'fixture:large-result'});
    const wire=await events.until(text=>text.includes('runtime_snapshot_required')&&text.includes('agent_end'));assert.ok(Buffer.byteLength(wire)<100000);assert.doesNotMatch(wire,/stream_reset|LARGE_NATIVE_BEGIN/);assert.match(wire,/tool_execution_end/);
    const native=await rpc('get_messages'),large=native.response.data.messages.findLast(message=>message.role==='toolResult');const payload=JSON.parse(large.content[0].text).payload;assert.equal(payload.length,5*1024*1024+'LARGE_NATIVE_BEGIN'.length+'LARGE_NATIVE_END'.length);assert.ok(payload.startsWith('LARGE_NATIVE_BEGIN')&&payload.endsWith('LARGE_NATIVE_END'));assert.equal(native.streamId,session.streamId);
  }finally{events.abort.abort();}
});

test('Pi HTTP request admission returns 413/not-started before writing an oversized image envelope to the native process',async()=>{
  const image={type:'image',mimeType:'image/png',data:'eHh4'.repeat(280000)};
  const response=await fetch(api+'/pi/sessions/recovery/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:'default',streamId:session.streamId,command:{type:'prompt',message:'must-not-send-large-images',images:[image,image]}})}),result=await response.json();assert.equal(response.status,413);assert.equal(result.code,'PI_RPC_REQUEST_LIMIT');assert.equal(result.outcome,'not-started');assert.equal(result.retryableByModel,false);assert.equal(fs.readFileSync(path.join(data,'pi-sessions/recovery/fixture-commands.jsonl'),'utf8').includes('must-not-send-large-images'),false);
});

test('real-process protocol failure returns a bounded unknown outcome rather than leaked text or an automatically replayed task',async()=>{
  const response=await fetch(api+'/pi/sessions/recovery/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:'default',streamId:session.streamId,command:{type:'prompt',message:'fixture:malformed-protocol'}})}),result=await response.json();assert.equal(response.status,502);assert.equal(result.ok,false);assert.equal(result.code,'PI_RPC_PROTOCOL_ERROR');assert.equal(result.outcome,'unknown');assert.equal(result.retryableByModel,false);assert.equal(result.recoverable,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_KEY/);
  session=await create();const native=await rpc('get_messages');assert.equal(native.ok,true);const log=fs.readFileSync(path.join(data,'pi-sessions/recovery/fixture-commands.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(log.filter(command=>command.type==='prompt'&&command.message==='fixture:malformed-protocol').length,1);
});
