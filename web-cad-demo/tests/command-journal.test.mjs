import assert from "node:assert/strict";
import test from "node:test";
import { ModelingController, workspaceFileName } from "../app/modeling/modeling-controller.ts";
import {idleWorkspaceResponse,activatedWorkspaceResponse} from './helpers/workspace-activation-fixture.mjs';
const response = (revision) => new Response(JSON.stringify({ ok: true, revision, positions: [], bodyId: `body-${revision}` }));

test("command journal records identity and timing but excludes raw inputs and parameters", async () => {
  const controller = new ModelingController({ fetchImpl: async () => response(1) });
  await controller.execute({ operation: "primitive.box", parameters: { width: 20, apiKey: "not-a-real-key" } });
  const [entry] = controller.getSnapshot().commandLog;
  assert.equal(entry.operation,"primitive.box"); assert.equal(entry.status,"success"); assert.equal(entry.revision,1);
  assert.ok(entry.requestId); assert.ok(entry.durationMs >= 0);
  assert.ok(!JSON.stringify(entry).includes("not-a-real-key"));
});

test('pure property commands update undo availability and the history signal without replacing the geometry model',async()=>{
  const replies=[{ok:true,revision:4,positions:[],bodyId:'body-1',history:{eventId:'geometry',canUndo:false,canRedo:false}},
    {ok:true,revision:4,type:{typeId:'type-1'},history:{eventId:'property-change',canUndo:true,canRedo:false}}];
  const controller=new ModelingController({fetchImpl:async()=>new Response(JSON.stringify(replies.shift()))});await controller.execute({operation:'document.view'});const model=controller.getSnapshot().model;
  await controller.execute({operation:'property.type.create',parameters:{key:'Setup',fields:[]}});assert.equal(controller.getSnapshot().model,model);assert.equal(controller.getSnapshot().revision,4);assert.equal(controller.getSnapshot().history.eventId,'property-change');assert.equal(controller.getSnapshot().history.canUndo,true);
});

test("concurrent commands remain busy until all finish and stale revisions do not overwrite the model", async () => {
  const pending = [];
  const controller = new ModelingController({ fetchImpl: () => new Promise((resolve) => pending.push(resolve)) });
  const first = controller.execute({ operation:"document.view" });
  const second = controller.execute({ operation:"primitive.box" });
  pending[1](response(2)); await second;
  assert.equal(controller.getSnapshot().busy,true); assert.equal(controller.getSnapshot().revision,2);
  pending[0](response(1)); await first;
  assert.equal(controller.getSnapshot().busy,false); assert.equal(controller.getSnapshot().revision,2);
  assert.equal(controller.getSnapshot().model.bodyId,"body-2");
  assert.equal(controller.getSnapshot().commandLog.length,2);
});

test("malformed responses become protocol errors and remain inspectable after clearing the current error", async () => {
  const controller = new ModelingController({ fetchImpl: async () => new Response("<h1>Not Found</h1>",{status:404}) });
  await assert.rejects(controller.execute({operation:"document.view"}), (error) => error.code === "INVALID_RESPONSE");
  assert.equal(controller.getSnapshot().busy,false); assert.equal(controller.getSnapshot().error.code,"INVALID_RESPONSE");
  controller.clearError(); assert.equal(controller.getSnapshot().error,null);
  assert.equal(controller.getSnapshot().commandLog[0].code,"INVALID_RESPONSE");
});

test("clearing the journal preserves active requests and history is bounded", async () => {
  let resolve; const controller = new ModelingController({fetchImpl:() => new Promise((done) => {resolve=done;})});
  const task=controller.execute({operation:"document.view"}); controller.clearCommandLog();
  assert.equal(controller.getSnapshot().commandLog.length,1); resolve(response(1)); await task;
  controller.clearCommandLog(); assert.equal(controller.getSnapshot().commandLog.length,0);
  const bounded = new ModelingController({ fetchImpl:async () => response(1) });
  for (let i=0;i<205;i++) await bounded.execute({operation:"document.view"});
  assert.equal(bounded.getSnapshot().commandLog.length,200);
});

test("clearing a document journal dismisses only a current error belonging to a cleared request", async () => {
  const controller = new ModelingController({fetchImpl: async () => new Response(JSON.stringify({ok:false,code:"INVALID_PARAMETER",error:"Invalid width"}),{status:400})});
  await assert.rejects(controller.execute({operation:"primitive.box"}), {code:"INVALID_PARAMETER"});
  controller.clearCommandLog("different-document");
  assert.equal(controller.getSnapshot().error.code,"INVALID_PARAMETER");
  assert.equal(controller.getSnapshot().commandLog.length,1);
  controller.clearCommandLog(controller.getSnapshot().documentId);
  assert.equal(controller.getSnapshot().error,null);
  assert.equal(controller.getSnapshot().commandLog.length,0);
});

test("opening without task capability never uploads or changes the active workspace identity or model",async()=>{
  let invalid=false;const controller=new ModelingController({fetchImpl:async()=>invalid ? new Response(JSON.stringify({ok:false,code:"INVALID_PROJECT_FILE",error:"damaged"}),{status:400}) : response(4)});
  await controller.execute({operation:"document.view"});const before=controller.getSnapshot();invalid=true;
  await assert.rejects(controller.openProject(new Blob(["bad file"])),{code:'PROJECT_OPEN_TASK_REQUIRED'});
  assert.equal(controller.getSnapshot().documentId,before.documentId);assert.deepEqual(controller.getSnapshot().model,before.model);assert.equal(controller.getSnapshot().revision,4);
});

test("unsupported project creation never resets the prior workspace and filenames remain safe",async()=>{
  let fail=false;const controller=new ModelingController({fetchImpl:async()=>fail ? new Response(JSON.stringify({ok:false,error:"disk failed",code:"DISK_ERROR"}),{status:400}) : response(5)});
  await controller.execute({operation:"document.view"});const before=controller.getSnapshot();fail=true;
  await assert.rejects(controller.createNewProject(),{code:'PROJECT_CREATE_TASK_REQUIRED'});assert.equal(controller.getSnapshot().documentId,before.documentId);assert.deepEqual(controller.getSnapshot().model,before.model);
  assert.equal(workspaceFileName("工程:测试/1"),"工程_测试_1.cadproj");
});

test("late read responses from the old workspace cannot replace an activated workspace",async()=>{
  let finish;const controller=new ModelingController({fetchImpl:async(url,init)=>url.endsWith('/activity')?idleWorkspaceResponse(url):url.endsWith('/activate') ? activatedWorkspaceResponse({ok:true,documentId:'next',revision:3,stateToken:'a'.repeat(64),stateSequence:1,positions:[],bodyId:'next-body'},init) : new Promise(resolve=>{finish=resolve;})});
  const old=controller.execute({operation:'document.view'});await controller.restoreWorkspace('next');finish(response(99));await old;
  assert.equal(controller.getSnapshot().documentId,'next');assert.equal(controller.getSnapshot().revision,3);assert.equal(controller.getSnapshot().model.bodyId,'next-body');
});
