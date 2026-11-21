import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { PiRpcSession, PiRpcRuntime, hasSavedPiSession, validatePiCommand } from "../gateway/pi-rpc-runtime.mjs";
function closeChild(child,code=0,signal=null){child.exitCode=code;child.signalCode=signal;child.emit('exit',code,signal);child.stdout.end();child.stderr.end();child.emit('close',code,signal);return true;}

test("Pi RPC exposes only declared commands and rejects arbitrary command fields", () => {
  assert.deepEqual(validatePiCommand({ type: "prompt", message: "Create a box" }), { type: "prompt", message: "Create a box" });
  assert.deepEqual(validatePiCommand({ type: "get_entries" }), { type: "get_entries" });
  assert.throws(() => validatePiCommand({ type: "bash", command: "dir" }), /Unsupported Pi RPC command/);
  assert.throws(() => validatePiCommand({ type: "new_session", parentSession: "C:\\private\\session.jsonl" }), /Unexpected field/);
  assert.throws(() => validatePiCommand({ type: "prompt", message: "ok", unexpected: true }), /Unexpected field/);
  assert.throws(() => validatePiCommand({ type: "prompt", message: "x".repeat(16_001) }), /16000 characters/);
});

test("Pi session switching cannot escape the session's private directory", () => {
  const root = path.join(os.tmpdir(), "web-cad-pi-session-test");
  const inside = path.join(root, "branch.jsonl");
  const outside = path.join(os.tmpdir(), "other-session.jsonl");
  assert.equal(validatePiCommand({ type: "switch_session", sessionPath: inside }, { sessionRoot: root }).sessionPath, inside);
  assert.throws(() => validatePiCommand({ type: "switch_session", sessionPath: outside }, { sessionRoot: root }), /inside the active session directory/);
  assert.throws(() => validatePiCommand({ type: "switch_session", sessionPath: inside }), /restricted to the active Pi session directory/);
});

test("a Pi RPC process restart resumes the saved conversation in its session directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-cad-pi-resume-test-"));
  try {
    assert.equal(await hasSavedPiSession(root), false);
    await writeFile(path.join(root, "not-a-session.txt"), "ignored");
    assert.equal(await hasSavedPiSession(root), false);
    await writeFile(path.join(root, "session.jsonl"), "{}\n");
    assert.equal(await hasSavedPiSession(root), true);
    const missing = path.join(root, "missing");
    assert.equal(await hasSavedPiSession(missing), false);
    await mkdir(missing);
    assert.equal(await hasSavedPiSession(missing), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi uses one modeling mode, restarts exited sessions and ignores an old child's exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lifecycle-"));
  const children = [], events = [];
  const session = new PiRpcSession({ sessionId: "test", documentId: "test", mode: "plan", cliPath: "fake.js", extensionPath: path.join(root,"extension.js"), cwd: root, sessionRoot: root, agentConfigDir: root, spawnImpl: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0;
    child.stdin = new Writable({ write(chunk, _encoding, done) { const command = JSON.parse(String(chunk)); queueMicrotask(() => child.stdout.write(JSON.stringify({ type:"response", id: command.id, success:true, data:{} }) + "\n")); done(); } });
    child.kill = () => closeChild(child); children.push(child); return child;
  } });
  session.on("event", ({event}) => events.push(event));
  try {
    await session.start(); assert.equal(session.mode, "edit");
    await session.stop(); await session.start({resume:true});
    children[0].emit("exit", null, "SIGTERM");
    assert.equal(session.child, children[1]); assert.equal(session.closed, false);
    assert.equal(events.some((event) => event.type === "runtime_error"), false);
    closeChild(children[1],1);
    const exit = events.find(event => event.type === "runtime_exit");
    assert.match(exit.error,/不会自动重发建模命令/);
    assert.equal(events.filter(event => event.type === "runtime_error").length,0);
    await session.setContext({ documentId:"test" });
    assert.equal(children.length, 3); assert.equal(session.closed, false);
    children[2].stdin.emit("error", new Error("broken pipe"));
    assert.equal(session.child, null); assert.equal(session.closed, true);
    await session.setContext({ documentId:"test" });
    assert.equal(children.length, 4); assert.equal(session.closed, false);
  } finally { await session.stop(); await rm(root, {recursive:true,force:true}); }
});

test("concurrent Pi connections await one handshake and never replay a modeling prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-concurrent-"));
  let child, handshakes = 0, complete;
  const session = new PiRpcSession({sessionId:"concurrent",documentId:"default",cliPath:"fake.js",extensionPath:path.join(root,"ext.js"),cwd:root,sessionRoot:root,agentConfigDir:root,spawnImpl:()=>{
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0;
    child.stdin = new Writable({write(chunk,_encoding,done){
      const command = JSON.parse(String(chunk)); assert.equal(command.type,"get_state"); handshakes++;
      const reply = () => child.stdout.write(JSON.stringify({type:"response",id:command.id,success:true,data:{}})+"\n");
      if (handshakes === 1) complete = reply; else queueMicrotask(reply); done();
    }}); child.kill=()=>closeChild(child); return child;
  }});
  try {
    const startup = session.start();
    while (!complete) await new Promise(resolve=>setImmediate(resolve));
    let ready = false; const connection = session.setContext({documentId:"default"}).then(()=>{ready=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ready,false); assert.equal(handshakes,1);
    complete(); await Promise.all([startup,connection]); assert.equal(handshakes,2);
  } finally {await session.stop();await rm(root,{recursive:true,force:true});}
});

test("failed Pi startup cleans the child and can be retried without replaying a prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-start-failure-"));
  let attempts = 0, kills = 0;
  const commands = [];
  const session = new PiRpcSession({sessionId:"failure",documentId:"default",cliPath:"fake.js",extensionPath:path.join(root,"ext.js"),cwd:root,sessionRoot:root,agentConfigDir:root,spawnImpl:()=>{
    attempts++;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode=0;
    child.stdin=new Writable({write(chunk,encoding,done){const command=JSON.parse(String(chunk));commands.push(command.type);queueMicrotask(()=>child.stdout.write(JSON.stringify({type:"response",id:command.id,success:attempts>1,error:"startup failed",data:{}})+"\n"));done();}});
    child.kill=()=>{kills++;return closeChild(child);};return child;
  }});
  try {
    await assert.rejects(session.start(),/startup failed/);assert.equal(session.child,null);assert.equal(kills,1);
    await session.start({resume:true});assert.equal(attempts,2);assert.deepEqual(commands,["get_state","get_state"]);
  } finally {await session.stop();await rm(root,{recursive:true,force:true});}
});

test("SIGTERM interrupts an in-flight native prompt and reconnect never resubmits it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-prompt-interrupted-"));
  const children = [], commands = [], events = [];
  const session = new PiRpcSession({ sessionId: "interrupted", documentId: "test", cliPath: "fake.js", extensionPath: path.join(root, "ext.js"), cwd: root, sessionRoot: root, agentConfigDir: root, spawnImpl: () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0;
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const command = JSON.parse(String(chunk)); commands.push(command);
      if (command.type !== "prompt") queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: {} }) + "\n"));
      done();
    } });
    child.kill = () => closeChild(child); children.push(child); return child;
  } });
  session.on("event", ({ event }) => events.push(event));
  try {
    await session.start();
    const pending = session.request({ type: "prompt", message: "创建一个长方体" });
    const rejected = assert.rejects(pending, /不会自动重发建模命令/);
    closeChild(children[0],null,'SIGTERM');
    await rejected;
    assert.equal(session.pending.size, 0);
    await session.setContext({ documentId: "test" });
    children[0].stdout.emit('data',Buffer.from(JSON.stringify({ type: "response", id: commands[1].id, success: true }) + "\n"));
    assert.equal(session.child, children[1]);
    assert.deepEqual(commands.map(command => command.type), ["get_state", "prompt", "get_state"]);
    assert.equal(events.filter(event => event.type === "runtime_exit").length, 1);
    assert.equal(events.filter(event => event.type === "runtime_error").length, 0);
  } finally { await session.stop(); await rm(root, { recursive: true, force: true }); }
});

test('runtime close waits for a retiring process and prevents an overlapping reconnect from resurrecting it',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pi-close-retiring-')),children=[];
  const runtime=new PiRpcRuntime({sessionRoot:root,agentConfigDir:root,cliPath:'fake.js',extensionPath:path.join(root,'ext.js'),cwd:root,spawnImpl:()=>{
    const child=new EventEmitter();child.pid=12000+children.length;child.exitCode=null;child.signalCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(chunk,_encoding,done){const command=JSON.parse(String(chunk));queueMicrotask(()=>child.stdout.write(JSON.stringify({type:'response',id:command.id,success:true,data:{}})+'\n'));done();}});
    child.kill=()=>true;children.push(child);return child;
  }});
  try{
    const session=await runtime.create({sessionId:'shared',documentId:'doc'});
    const removing=runtime.remove('shared');
    assert.equal(runtime.retiring.has(session),true);
    const reconnecting=runtime.create({sessionId:'shared',documentId:'doc'});
    const rejected=assert.rejects(reconnecting,/shutting down|永久关闭/);
    let closed=false;const closing=runtime.close().then(()=>{closed=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false,'Removing a session must not erase its live exit barrier');
    children[0].exitCode=0;children[0].emit('exit',0,null);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false,'OS exit alone must not bypass stdio closure');
    children[0].stdout.end();children[0].stderr.end();children[0].emit('close',0,null);
    await Promise.all([removing,closing,rejected]);assert.equal(children.length,1);
    await assert.rejects(session.start(),/永久关闭/);
    await assert.rejects(runtime.create({sessionId:'later'}),/shutting down/);
  }finally{for(const child of children)closeChild(child);await runtime.close();await rm(root,{recursive:true,force:true});}
});

test('permanent Pi disposal cancels a restart already waiting for the old process to exit',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pi-close-restart-'));let spawns=0,child;
  const session=new PiRpcSession({sessionId:'restart',cliPath:'fake.js',extensionPath:path.join(root,'ext.js'),cwd:root,sessionRoot:root,agentConfigDir:root,spawnImpl:()=>{
    spawns++;child=new EventEmitter();child.pid=12000;child.exitCode=null;child.signalCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(chunk,_encoding,done){const command=JSON.parse(String(chunk));queueMicrotask(()=>child.stdout.write(JSON.stringify({type:'response',id:command.id,success:true,data:{}})+'\n'));done();}});child.kill=()=>true;return child;
  }});
  try{
    await session.start();const stopping=session.stop(),restart=session.start({resume:true});
    // Use the runtime's terminal operation, distinct from a reusable stop/restart.
    assert.equal(typeof session.dispose,'function');const disposing=session.dispose();
    const rejected=assert.rejects(restart,/永久关闭/);
    closeChild(child);await Promise.all([stopping,disposing,rejected]);assert.equal(spawns,1);
  }finally{if(child)closeChild(child);await session.stop();await rm(root,{recursive:true,force:true});}
});
