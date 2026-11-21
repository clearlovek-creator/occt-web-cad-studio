import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
function probe(bytes,blocks=0){
  assert.ok(process.env.GEOMETRY_WORKER_PATH,'Use the registered native test pair');const environment={...process.env,GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:String(bytes)};
  const inherited=environment.Path||environment.PATH||'';delete environment.Path;delete environment.PATH;environment.PATH=['C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  return spawnSync(path.join(path.dirname(process.env.GEOMETRY_WORKER_PATH),'native_resource_probe.exe'),[String(blocks)],{cwd:root,env:environment,windowsHide:true,encoding:'utf8',timeout:15000});
}
test('real Windows job commit cap refuses allocations that succeed under a larger independently verified cap',()=>{
  const control=probe(256*1024*1024,20);assert.equal(control.status,0,control.stderr+'\n'+control.stdout);const accepted=control.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.equal(accepted[0].jobLimitBytes,256*1024*1024);assert.equal(accepted.at(-1).allocatedBytes,160*1024*1024);
  const limited=probe(128*1024*1024,20);assert.ok([86,87].includes(limited.status),limited.error?.message+'\n'+limited.stderr+'\n'+limited.stdout);const denied=limited.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.equal(denied[0].enforced,true);assert.equal(denied[0].processLimitBytes,128*1024*1024);assert.ok(denied.at(-1).allocatedBytes<128*1024*1024);
});
test('memory retirement cannot block on a saturated native diagnostic pipe',async()=>{
  const env={...process.env,GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:String(128*1024*1024)},inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=['C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  const child=spawn(path.join(path.dirname(process.env.GEOMETRY_WORKER_PATH),'native_resource_probe.exe'),['20','--saturate-stderr'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',saturated=false;child.stdout.on('data',bytes=>output+=bytes);const onReadable=()=>{saturated||=child.stderr.readableLength>0;};child.stderr.on('readable',onReadable);const closed=new Promise(resolve=>child.once('close',resolve));
  // Deliberately do not read stderr until exit: its high-water mark and the OS
  // pipe must provide backpressure to the writer, not an unbounded collector.
  let timer;try{const code=await Promise.race([new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);}),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('OOM retirement blocked on diagnostics')),5000))]);assert.ok([86,87].includes(code),output);assert.ok(saturated,'Probe did not fill diagnostics');}
  finally{clearTimeout(timer);if(child.exitCode==null&&child.signalCode==null)child.kill();child.stderr.off('readable',onReadable);child.stderr.resume();await closed;}
});
test('invalid native memory policy exits before advertising a guard or doing any allocation test',()=>{
  for(const value of [0,1,'bad',9*1024**3]){const result=probe(value);assert.equal(result.status,89,result.stderr);assert.equal(result.stdout,'');}
});
