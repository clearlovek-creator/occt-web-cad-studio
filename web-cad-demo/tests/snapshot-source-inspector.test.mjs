import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {SnapshotSourceInspector} from '../gateway/snapshot-source-inspector.mjs';
function fixture(t,spawnImpl){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-snapshot-proof-')),file=path.join(root,'checkpoint.xbf'),exe=path.join(root,'fixture.exe');fs.writeFileSync(file,'BINFILE'+'x'.repeat(64));fs.writeFileSync(exe,'fixture');const inspector=new SnapshotSourceInspector({executablePath:exe,spawnImpl,env:{PATH:'path',OPENAI_API_KEY:'must-not-forward'},timeoutMs:1000,stopTimeoutMs:20});t.after(async()=>{await inspector.close();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});return{root,file,inspector};}
function child(onInput){const c=new EventEmitter();Object.assign(c,{pid:123,exitCode:null,signalCode:null,killed:false,stdout:new PassThrough(),stderr:new PassThrough()});let input='';c.stdin=new Writable({write(chunk,_encoding,next){input+=chunk;next();},final(next){next();queueMicrotask(()=>onInput(c,JSON.parse(input)));}});c.kill=()=>{c.killed=true;return true;};return c;}
function end(c,value){const bytes=Buffer.from(JSON.stringify(value)+'\n');for(let index=0;index<bytes.length;index+=3)c.stdout.write(bytes.subarray(index,index+3));c.exitCode=0;c.emit('exit',0,null);c.stdout.end();c.emit('close',0,null);}
const result={ok:true,version:1,metadataComplete:true,sources:[{featureId:'feature-1',sourcePath:'D:/工程/来源.step',sourceFingerprintAlgorithm:'sha256-chain-1m-v1',sourceFingerprint:'a'.repeat(64)}]};

test('configured managed roots reject external snapshots and linked parent directories before native execution',async t=>{
  let spawns=0;const f=fixture(t,()=>{spawns++;return child(c=>end(c,result));});
  const managed=path.join(f.root,'managed'),outside=path.join(f.root,'outside');fs.mkdirSync(managed);fs.mkdirSync(outside);
  f.inspector.roots=[managed];await assert.rejects(f.inspector.inspect(f.file),error=>error.code==='SOURCE_SNAPSHOT_UNTRUSTED');
  fs.writeFileSync(path.join(outside,'snapshot.xbf'),'BINFILE'+'x'.repeat(64));
  const link=path.join(managed,'linked');fs.symlinkSync(outside,link,'junction');
  try{await assert.rejects(f.inspector.inspect(path.join(link,'snapshot.xbf')),error=>error.code==='SOURCE_SNAPSHOT_UNTRUSTED');}finally{fs.unlinkSync(link);}
  assert.equal(spawns,0);
});
test('Unicode metadata survives split output; environment is private and cache requires a full content match',async t=>{
  let calls=0;const f=fixture(t,(_exe,_args,options)=>{calls++;assert.equal(options.env.OPENAI_API_KEY,undefined);return child((c,input)=>{assert.equal(input.path,f.file);end(c,result);});});
  const first=await f.inspector.inspect(f.file);assert.equal(first.sources[0].sourcePath,result.sources[0].sourcePath);first.sources.length=0;assert.equal((await f.inspector.inspect(f.file)).sources.length,1);assert.equal(calls,1);
  fs.appendFileSync(f.file,'different');await f.inspector.inspect(f.file);assert.equal(calls,2);
  await assert.rejects(f.inspector.inspect(f.file,{expectedSha256:'0'.repeat(64)}),error=>error.code==='SOURCE_SNAPSHOT_CHECKSUM');assert.equal(calls,2);
});
test('exit before the final stdout bytes is not mistaken for a complete response',async t=>{
  const f=fixture(t,()=>child(c=>{const text=JSON.stringify(result)+'\n';c.stdout.write(text.slice(0,10));c.exitCode=0;c.emit('exit',0,null);setTimeout(()=>{c.stdout.end(text.slice(10));c.emit('close',0,null);},5);}));assert.equal((await f.inspector.inspect(f.file)).sources.length,1);
});
test('malformed and wrong-version metadata cannot populate the trusted cache',async t=>{
  let calls=0;const f=fixture(t,()=>child(c=>{calls++;end(c,{...result,version:99});}));for(let i=0;i<2;i++)await assert.rejects(f.inspector.inspect(f.file),error=>error.code==='SOURCE_INSPECTOR_PROTOCOL');assert.equal(calls,2);
});
test('checkpoint changes during native inspection reject even an otherwise valid response',async t=>{
  const f=fixture(t,()=>child(c=>{fs.appendFileSync(f.file,'changed');end(c,result);}));await assert.rejects(f.inspector.inspect(f.file),error=>error.code==='SOURCE_SNAPSHOT_CHANGED');
});
test('aborted inspections keep an unconfirmed child owned until its actual exit',async t=>{
  let native,ready;const started=new Promise(resolve=>ready=resolve),f=fixture(t,()=>native=child(()=>ready())),controller=new AbortController();
  const inspecting=f.inspector.inspect(f.file,{signal:controller.signal}),rejected=assert.rejects(inspecting,error=>error.code==='SOURCE_INSPECTOR_STOP_UNCONFIRMED'&&error.exitObserved instanceof Promise);
  await started;controller.abort();await rejected;assert.equal(native.killed,true);assert.equal(f.inspector.children.size,1);native.signalCode='SIGTERM';native.emit('exit',null,'SIGTERM');native.emit('close',null,'SIGTERM');assert.equal(f.inspector.children.size,0);
});
test('a closed inspector or invalid checkpoint cannot start native work',async t=>{
  let count=0;const f=fixture(t,()=>{count++;throw Error('must not start');});fs.writeFileSync(f.file,'not XBF');await assert.rejects(f.inspector.inspect(f.file));await f.inspector.close();await assert.rejects(f.inspector.inspect(f.file),error=>error.code==='SOURCE_INSPECTION_INTERRUPTED');assert.equal(count,0);
});
