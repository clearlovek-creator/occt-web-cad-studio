import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
async function launch(data,port,extra={}){
  const child=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GEOMETRY_DATA_DIR:data,GEOMETRY_PORT:String(port),...extra}});let output='';
  const outcome=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Gateway ownership test startup timeout')),15000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({kind:'exit',code});});child.stderr.on('data',chunk=>output+=chunk);child.stdout.on('data',chunk=>{output+=chunk;if(chunk.includes('Geometry gateway ready')){clearTimeout(timer);resolve({kind:'ready'});}});});return {child,outcome,get output(){return output;}};
}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}
async function command(port,operation,parameters={}){const response=await fetch(`http://127.0.0.1:${port}/api/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:'default',operation,parameters}),signal:AbortSignal.timeout(10000)}),result=await response.json();assert.ok(response.ok&&result.ok,result.error);return result;}
function protectedFiles(data){const files={};function scan(directory){if(!fs.existsSync(directory))return;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())scan(file);else if(entry.isFile())files[path.relative(data,file)]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');}}for(const name of ['history','property-schemas'])scan(path.join(data,name));return files;}
test('different ports cannot start two writers for the same physical data directory',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-writer-api-'));let first,second;
  try{first=await launch(data,8908);assert.equal(first.outcome.kind,'ready',first.output);const before=await command(8908,'primitive.box',{width:11,depth:12,height:13}),files=protectedFiles(data);second=await launch(data,8909,{GEOMETRY_ALLOW_TEMP_DATA_FALLBACK:'true'});assert.equal(second.outcome.kind,'exit','A second Gateway must be rejected even when it uses a different TCP port');assert.match(second.output,/DATA_DIRECTORY_IN_USE/);assert.deepEqual(protectedFiles(data),files,'A rejected writer must not initialize, migrate or recover project files');assert.equal((await command(8908,'document.summary')).stateToken,before.stateToken);}
  finally{await stop(second?.child);await stop(first?.child);assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
});
test('a terminated Gateway releases ownership and the next owner restores exact project state',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-writer-crash-'));let first,next;
  try{first=await launch(data,8908);assert.equal(first.outcome.kind,'ready');await command(8908,'property.type.create',{key:'OwnerProof',fields:[]});const saved=await command(8908,'primitive.box',{width:11,depth:12,height:13}),files=protectedFiles(data),oldOwner=JSON.parse(fs.readFileSync(path.join(data,'.cad-writer.lock')));await stop(first.child);next=await launch(data,8909);assert.equal(next.outcome.kind,'ready',next.output);const restored=await command(8909,'document.summary');assert.equal(restored.stateToken,saved.stateToken);assert.equal(restored.revision,saved.revision);assert.equal(restored.bodyCount,1);assert.deepEqual(protectedFiles(data),files);assert.ok((await command(8909,'property.type.list')).types.some(type=>type.key==='OwnerProof'));const owner=JSON.parse(fs.readFileSync(path.join(data,'.cad-writer.lock')));assert.notEqual(owner.instanceId,oldOwner.instanceId);assert.equal(owner.pid,next.child.pid);}
  finally{await stop(next?.child);await stop(first?.child);assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
});
test('independent data directories permit independent Gateways with truthful health ownership',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cad-writer-independent-')),a=path.join(base,'a'),b=path.join(base,'b');let first,second;
  try{[first,second]=await Promise.all([launch(a,8908),launch(b,8909)]);assert.equal(first.outcome.kind,'ready',first.output);assert.equal(second.outcome.kind,'ready',second.output);const box=await command(8908,'primitive.box',{width:10,depth:10,height:10}),sphere=await command(8909,'primitive.sphere',{radius:3});assert.notEqual(box.bodyMetadata[0].bodyIdentity,sphere.bodyMetadata[0].bodyIdentity);for(const [port,child] of [[8908,first.child],[8909,second.child]]){const health=await fetch(`http://127.0.0.1:${port}/api/health`).then(response=>response.json());assert.equal(health.storage.writer.ownerPid,child.pid);assert.equal(health.storage.writer.mechanism,'windows-kernel-file-sharing');}}
  finally{await stop(second?.child);await stop(first?.child);assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(base,{recursive:true,force:true});}
});
test('simultaneous Gateway startup has one owner before persistent initialization',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-writer-race-'));let contenders=[];
  try{contenders=await Promise.all([launch(data,8908),launch(data,8909)]);assert.equal(contenders.filter(item=>item.outcome.kind==='ready').length,1);const rejected=contenders.find(item=>item.outcome.kind==='exit');assert.match(rejected.output,/DATA_DIRECTORY_IN_USE/);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'.cad-writer.lock'))).pid,contenders.find(item=>item.outcome.kind==='ready').child.pid);}
  finally{await Promise.all(contenders.map(item=>stop(item.child)));assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
});
