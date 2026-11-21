import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..'),helper=path.join(root,'geometry-worker/build/cad_data_directory_lock.exe');
function fixture(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-writer-lock-中文-')),data=path.join(directory,'工程数据');fs.mkdirSync(data);return {directory,data};}
async function owner(directory,mode='hold'){
  const child=spawn(process.execPath,['tests/fixtures/data-writer-owner.mjs',directory,mode],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Writer owner fixture timeout')),10000);child.once('error',reject);child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve({kind:'ready',...JSON.parse(stdout.trim())});}});child.stderr.on('data',chunk=>stderr+=chunk);child.once('exit',code=>{clearTimeout(timer);resolve({kind:'exit',code,stderr});});});return {child,result};
}
async function stop(child,graceful=false){if(!child||child.exitCode!==null||child.signalCode!==null)return;const ended=new Promise(resolve=>child.once('exit',resolve));if(graceful)child.stdin.write('exit\n');else child.kill();await ended;}
function cleanup(directory){assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(directory).startsWith('cad-writer-lock-'));fs.rmSync(directory,{recursive:true,force:true});}

test('the Gateway process keeps the kernel lock after the bootstrap executable has already exited',async()=>{
  const f=fixture();let first,second;
  try{first=await owner(f.data);assert.equal(first.result.kind,'ready');assert.equal(first.result.lease.ownerPid,first.child.pid);second=await owner(f.data);assert.equal(second.result.kind,'exit');assert.match(second.result.stderr,/DATA_DIRECTORY_IN_USE/);assert.equal(JSON.parse(fs.readFileSync(path.join(f.data,'.cad-writer.lock'))).pid,first.child.pid);}
  finally{await stop(second?.child);await stop(first?.child);cleanup(f.directory);}
});
for(const graceful of [true,false])test(`kernel ownership releases on ${graceful?'normal exit':'forced process termination'}, without deleting a stale marker`,async()=>{
  const f=fixture();let first,next;
  try{first=await owner(f.data);assert.equal(first.result.kind,'ready');await stop(first.child,graceful);assert.ok(fs.existsSync(path.join(f.data,'.cad-writer.lock')));next=await owner(f.data);assert.equal(next.result.kind,'ready');assert.notEqual(next.result.lease.instanceId,first.result.lease.instanceId);}
  finally{await stop(next?.child);await stop(first?.child);cleanup(f.directory);}
});
test('directory aliases contend for the same physical lock and cannot bypass ownership',async()=>{
  const f=fixture(),alias=path.join(f.directory,'目录别名');fs.symlinkSync(f.data,alias,'junction');let first,second;
  try{first=await owner(f.data);assert.equal(first.result.kind,'ready');second=await owner(alias);assert.equal(second.result.kind,'exit');assert.match(second.result.stderr,/DATA_DIRECTORY_IN_USE/);}
  finally{await stop(second?.child);await stop(first?.child);cleanup(f.directory);}
});
test('an active owner denies marker deletion/overwrite and root-directory rename',async()=>{
  const f=fixture(),movedParent=f.directory+'-moved';let first;
  try{first=await owner(f.data);assert.equal(first.result.kind,'ready');const file=path.join(f.data,'.cad-writer.lock'),original=fs.readFileSync(file);assert.throws(()=>fs.rmSync(file),/EPERM|EACCES|EBUSY/);assert.throws(()=>fs.writeFileSync(file,'changed'),/EPERM|EACCES|EBUSY/);assert.throws(()=>fs.renameSync(f.data,path.join(f.directory,'moved')),/EPERM|EACCES|EBUSY/);assert.throws(()=>fs.renameSync(f.directory,movedParent),/EPERM|EACCES|EBUSY/);assert.deepEqual(fs.readFileSync(file),original);}
  finally{await stop(first?.child);if(fs.existsSync(movedParent))fs.renameSync(movedParent,f.directory);cleanup(f.directory);}
});
test('stale metadata naming a live PID never causes process termination or prevents a valid new lock',async()=>{
  const f=fixture();let first;
  try{fs.writeFileSync(path.join(f.data,'.cad-writer.lock'),JSON.stringify({pid:process.pid,instanceId:'stale-record-only'}));first=await owner(f.data);assert.equal(first.result.kind,'ready');assert.equal(process.kill(process.pid,0),true);}
  finally{await stop(first?.child);cleanup(f.directory);}
});
test('simultaneous contenders have exactly one kernel-lock winner',async()=>{
  const f=fixture(),owners=[];
  try{owners.push(...await Promise.all(Array.from({length:6},()=>owner(f.data))));assert.equal(owners.filter(item=>item.result.kind==='ready').length,1);assert.ok(owners.filter(item=>item.result.kind==='exit').every(item=>item.result.stderr.includes('DATA_DIRECTORY_IN_USE')));}
  finally{await Promise.all(owners.map(item=>stop(item.child)));cleanup(f.directory);}
});
test('lock handles do not leak into a surviving descendant process',async()=>{
  const f=fixture();let first,next;
  try{first=await owner(f.data,'descendant');assert.equal(first.result.kind,'ready');await stop(first.child,true);const descendant=first.result.descendant;
    const reply=await new Promise((resolve,reject)=>{const socket=net.connect(descendant.port,'127.0.0.1'),chunks=[];socket.setTimeout(2000,()=>socket.destroy(Error('Descendant timeout')));socket.on('data',chunk=>chunks.push(chunk));socket.once('error',reject);socket.once('end',()=>resolve(Buffer.concat(chunks).toString()));});assert.equal(reply,descendant.nonce,'The exact descendant must still be alive');next=await owner(f.data);assert.equal(next.result.kind,'ready');}
  finally{await stop(next?.child);await stop(first?.child);cleanup(f.directory);}
});
test('hard-linked lock markers and forged owner PIDs fail before modifying any target file',()=>{
  const f=fixture(),outside=path.join(f.directory,'保留文件.txt'),marker=path.join(f.data,'.cad-writer.lock');
  try{fs.writeFileSync(outside,'must not change');fs.linkSync(outside,marker);const linked=spawnSync(helper,[f.data,String(process.pid),randomUUID()],{windowsHide:true,encoding:'utf8'});assert.equal(JSON.parse(linked.stdout).code,'DATA_DIRECTORY_LOCK_INVALID');assert.equal(fs.readFileSync(outside,'utf8'),'must not change');fs.rmSync(marker);const forged=spawnSync(helper,[f.data,'1',randomUUID()],{windowsHide:true,encoding:'utf8'});assert.equal(JSON.parse(forged.stdout).code,'DATA_DIRECTORY_OWNER_INVALID');assert.equal(fs.existsSync(marker),false);}
  finally{cleanup(f.directory);}
});
test('a missing native lock component fails closed without creating a marker or project state',async()=>{
  const f=fixture();let attempted;
  try{attempted=await owner(f.data,'missing-helper');assert.equal(attempted.result.kind,'exit');assert.match(attempted.result.stderr,/DATA_DIRECTORY_LOCK_UNAVAILABLE/);assert.deepEqual(fs.readdirSync(f.data),[]);}
  finally{await stop(attempted?.child);cleanup(f.directory);}
});
