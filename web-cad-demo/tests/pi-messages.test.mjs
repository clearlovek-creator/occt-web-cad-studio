import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../app/modeling/pi-messages.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {applyNativePiMessage, applyPiToolEvent, flattenMessages, isNearPiConversationEnd, mergeToolMessage, piRuntimeError, piToolSummary, piThinkingSummary, shouldSubmitPiMessage,piToolNeedsReconcile,piDetailPage,PI_DETAIL_PAGE_SIZE} = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test('verified user cancellation is neutral and explicit, without changing the native error or result text',()=>{
  const task={version:1,taskId:'11111111-1111-4111-8111-111111111111',documentId:'default',operation:'primitive.box',requestKey:'original',phase:'cancelled',cancelRequested:true,restored:true};
  const result={ok:false,requestId:'original',outcome:'restored',modelingTask:task},item={role:'tool',id:'cancel',toolName:'primitive__box',status:'error',resultText:JSON.stringify(result),content:JSON.stringify(result)},before=structuredClone(item);
  assert.equal(piToolSummary(item),'primitive__box · 已取消，原工程已恢复');assert.deepEqual(item,before);
  assert.equal(piToolSummary({...item,resultText:JSON.stringify({...result,outcome:'not-started',modelingTask:{...task,restored:false,execution:'not-started'}})}),'primitive__box · 已取消，未执行');
});
test('a cancellation label cannot claim restoration from mismatching task identity or missing proof',()=>{
  const task={version:1,taskId:'11111111-1111-4111-8111-111111111111',documentId:'default',operation:'primitive.box',requestKey:'original',phase:'cancelled',cancelRequested:true,restored:true};
  for(const patch of [{requestKey:'foreign'},{operation:'body.delete'},{restored:false},{cancelRequested:false},{taskId:'invented'}])assert.equal(piToolSummary({role:'tool',id:'bad',toolName:'primitive__box',status:'error',content:'',resultText:JSON.stringify({ok:false,requestId:'original',outcome:'restored',modelingTask:{...task,...patch}})}),'primitive__box · 失败');
});
test('unknown tool outcomes stay visible as a verification requirement, not successful cancellation',()=>{
  assert.equal(piToolSummary({role:'tool',id:'unknown',toolName:'primitive__box',status:'error',content:'',resultText:JSON.stringify({ok:false,outcome:'unknown'})}),'primitive__box · 结果待核对');
});

test('detail paging bounds each DOM slice without splitting Unicode or changing full copied content',()=>{
  const content='x'.repeat(PI_DETAIL_PAGE_SIZE-1)+'🙂'+'几何'.repeat(PI_DETAIL_PAGE_SIZE)+'END',pages=piDetailPage(content,0).pages;
  const pieces=Array.from({length:pages},(_,index)=>piDetailPage(content,index).text);
  assert.equal(pieces.join(''),content);assert.ok(pieces.every(text=>text.length<=PI_DETAIL_PAGE_SIZE+1&&text.isWellFormed()));assert.equal(piDetailPage(content,999).index,pages-1);assert.equal(piDetailPage(content,NaN).index,0);assert.equal(piDetailPage('',0).text,'');
});

test('tool summaries never parse an entire multi-megabyte native result just to draw a collapsed line',t=>{
  const original=JSON.stringify({ok:true,payload:'x'.repeat(100000)}),parse=t.mock.method(JSON,'parse',()=>{throw Error('Summary must not parse large data');});
  assert.equal(piToolSummary({id:'large',role:'tool',toolName:'query_model',status:'done',resultText:original,content:original}),'query_model · 完成');assert.equal(parse.mock.callCount(),0);
});

test('native read-only MCP tools do not trigger geometry reloads; failed or unknown mutations still need reconciliation',()=>{
  for(const name of ['query_model','geometry__measure','geometry__check','geometry__relation','body__presentation','property__list','property__type__list','property__instance__list','property__package__export'])assert.equal(piToolNeedsReconcile(name),false,name);
  for(const name of ['primitive__box','boolean__cut','body__delete','feature__update','unexpected_tool'])assert.equal(piToolNeedsReconcile(name),true,name);
});

test("native tool progress replaces accumulated snapshots and cannot reopen a settled tool", () => {
  const base = {toolCallId:"call-progress",toolName:"query_model",args:{kind:"spatial"}};
  let messages = applyPiToolEvent([], {...base,type:"tool_execution_start"});
  for (const text of ["one", "one two"]) messages = applyPiToolEvent(messages, {...base,type:"tool_execution_update",partialResult:{content:[{type:"text",text}]}});
  assert.equal(messages.length, 1);
  assert.equal(messages[0].resultText, "one two");
  assert.equal(messages[0].status, "running");
  assert.match(messages[0].argumentsText, /spatial/);
  messages = applyPiToolEvent(messages, {...base,type:"tool_execution_end",result:{content:[{type:"text",text:"final"}]},isError:false});
  assert.equal(messages[0].resultText, "final");
  assert.equal(messages[0].status, "done");
  const settled = messages;
  assert.equal(applyPiToolEvent(messages, {...base,type:"tool_execution_update",partialResult:{content:"late"}}), settled);
  assert.equal(applyPiToolEvent(messages, {type:"tool_execution_start"}), settled);
  messages = applyPiToolEvent([], {...base,type:"tool_execution_end",result:{isError:true,content:"failed"}});
  assert.equal(messages[0].status, "error");
});

test("Pi exit diagnostics explain recovery for current and older gateways without hiding the signal", () => {
  for (const event of [{type:"runtime_exit",code:null,signal:"SIGTERM"},{type:"runtime_error",error:"Pi RPC process exited (code=-, signal=SIGTERM)."}]) {
    const message = piRuntimeError(event);
    assert.match(message,/SIGTERM/);
    assert.match(message,/不会重发/);
    assert.match(message,/查询当前工程/);
  }
  assert.equal(piRuntimeError({type:"runtime_error",error:"MCP connection failed"}),"MCP connection failed");
});

test("Chinese IME confirmation and Shift+Enter never submit a modeling request", () => {
  assert.equal(shouldSubmitPiMessage({key:"Enter",shiftKey:false,isComposing:true}),false);
  assert.equal(shouldSubmitPiMessage({key:"Enter",shiftKey:false,keyCode:229}),false);
  assert.equal(shouldSubmitPiMessage({key:"Enter",shiftKey:true}),false);
  assert.equal(shouldSubmitPiMessage({key:"a",shiftKey:false}),false);
  assert.equal(shouldSubmitPiMessage({key:"Enter",shiftKey:false,isComposing:false,keyCode:13}),true);
});

test("Pi follows the latest messages only while the reader is near the end", () => {
  assert.equal(isNearPiConversationEnd({scrollTop: 600, scrollHeight: 1000, clientHeight: 400}), true);
  assert.equal(isNearPiConversationEnd({scrollTop: 568, scrollHeight: 1000, clientHeight: 400}), true);
  assert.equal(isNearPiConversationEnd({scrollTop: 300, scrollHeight: 1000, clientHeight: 400}), false);
  assert.equal(isNearPiConversationEnd({scrollTop: 0, scrollHeight: 100, clientHeight: 400}), true);
  assert.equal(isNearPiConversationEnd({scrollTop: NaN, scrollHeight: 1000, clientHeight: 400}), false);
});

test("thinking summary stays short while complete native reasoning remains expandable", () => {
  const message = { id: "thought", role: "thinking", status: "streaming", content: "检查底面\n\n  和高度。" + "空间约束".repeat(100) };
  const original = message.content;
  const summary = piThinkingSummary(message);
  assert.match(summary, /^思考过程 · 进行中 · 检查底面 和高度/);
  assert.ok(summary.length < 100);
  assert.ok(summary.endsWith("…"));
  assert.equal(message.content, original);
  assert.match(piThinkingSummary({ ...message, status: "interrupted" }), /已中断/);
});

test("Pi presentation separates native thinking, tool arguments and results without changing context", () => {
  const original = [{role:"assistant",content:[{type:"thinking",thinking:"核对尺寸"},{type:"text",text:"创建长方体"},{type:"toolCall",id:"call1",name:"primitive__box",arguments:{parameters:{width:"W",depth:20,height:10}}}]},{role:"toolResult",toolCallId:"call1",toolName:"primitive__box",content:[{type:"text",text:'{"ok":true,"bodyId":"body-7"}'}]}];
  const serialized = JSON.stringify(original);
  const messages = flattenMessages(original);
  assert.deepEqual(messages.map(message => message.role), ["thinking","assistant","tool"]);
  assert.equal(messages[2].toolCallId,"call1");
  assert.match(messages[2].content,/"width": "W"/);
  assert.match(messages[2].content,/body-7/);
  assert.equal(messages[2].status,"done");
  assert.equal(piToolSummary(messages[2]),"primitive__box · 完成 · body-7");
  assert.equal(JSON.stringify(original),serialized);
  assert.deepEqual(flattenMessages(null),[]);
});

test("streamed Pi tool results merge by call id without swallowing parallel calls or reordering text", () => {
  const start = {id:"a",role:"tool",toolCallId:"call-a",toolName:"query_model",content:"{}",argumentsText:"{}",status:"running"};
  let messages = mergeToolMessage([],start);
  messages = [...messages,{id:"text",role:"assistant",content:"正在检查"}];
  messages = mergeToolMessage(messages,{...start,id:"b",toolCallId:"call-b"});
  messages = mergeToolMessage(messages,{id:"end-a",role:"tool",toolCallId:"call-a",toolName:"query_model",content:'{"bodyCount":5}',resultText:'{"bodyCount":5}',status:"done"});
  assert.deepEqual(messages.map(item=>item.id),["a","text","b"]);
  assert.equal(piToolSummary(messages[0]),"query_model · 完成 · 5 个 Body");
  assert.equal(messages[2].status,"running");
  assert.match(messages[0].content,/参数\n\{\}\n\n结果/);
  const detached = mergeToolMessage([],{id:"end",role:"tool",toolCallId:"late",content:"failure",resultText:"failure",status:"error"});
  assert.equal(piToolSummary(detached[0]),"CAD 工具 · 失败");
  assert.equal(detached[0].resultText,"failure");
  assert.match(piToolSummary({...start,status:"interrupted"}),/已中断，结果待核对/);
  assert.match(piToolSummary({...start,status:"call"}),/未收到结果/);
});
test('native full-message updates replace their own partial text without duplicated deltas or lost tool results',()=>{
  const message={role:'assistant',timestamp:123,content:[{type:'thinking',thinking:'check'},{type:'text',text:'partial'},{type:'toolCall',id:'call',name:'primitive__box',arguments:{parameters:{width:'W'}}}]};
  let messages=flattenMessages([message]);messages=mergeToolMessage(messages,{id:'done',role:'tool',toolCallId:'call',toolName:'primitive__box',content:'done',resultText:'{"ok":true}',status:'done'});
  const next=structuredClone(message);next.content[1].text='partial and complete';messages=applyNativePiMessage(messages,{type:'message_update',message:next});assert.deepEqual(messages.map(item=>item.role),['thinking','assistant','tool']);assert.equal(messages[1].content,'partial and complete');assert.equal(messages[2].status,'done');assert.match(messages[2].content,/ok/);assert.equal(message.content[1].text,'partial');
  messages=applyNativePiMessage(messages,{type:'message_end',message:{...next,stopReason:'aborted'}});assert.equal(messages[1].status,'interrupted');assert.match(piThinkingSummary(messages[0]),/已中断/);
});
test('parallel native tool results with an equal timestamp keep distinct presentation IDs',()=>{
  const messages=flattenMessages(['one','two'].map(toolCallId=>({role:'toolResult',timestamp:123,toolCallId,toolName:'query_model',content:'result'})));assert.equal(new Set(messages.map(item=>item.id)).size,2);
});

test('tool details keep the same identity across live events and native history snapshots',()=>{
  const native={role:'assistant',timestamp:55,content:[{type:'toolCall',id:'stable',name:'primitive__box',arguments:{parameters:{width:20}}}]};
  let live=applyPiToolEvent([],{type:'tool_execution_start',toolCallId:'stable',toolName:'primitive__box',args:{parameters:{width:20}}});
  const id=live[0].id;
  live=applyNativePiMessage(live,{type:'message_update',message:native});
  assert.equal(live.length,1,'A native call snapshot must not append a second row');
  assert.equal(live[0].id,id);assert.equal(live[0].status,'running');
  live=applyPiToolEvent(live,{type:'tool_execution_end',toolCallId:'stable',result:{content:'created'},isError:false});
  const history=flattenMessages([native,{role:'toolResult',toolCallId:'stable',toolName:'primitive__box',content:'created'}]);
  assert.equal(history[0].id,id);assert.equal(history[0].content,live[0].content);
  assert.equal(history[0].status,'done');
});
