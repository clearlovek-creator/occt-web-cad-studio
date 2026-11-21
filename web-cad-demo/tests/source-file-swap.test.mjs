import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {SourceFileSwap} from '../gateway/source-file-swap.mjs';
import {managedStepDestination,managedStepPath,restorationStepPath,hashManagedStepSource,hashRestorationStepSource} from '../gateway/step-source-integrity.mjs';

const executablePath=path.resolve('geometry-worker/build/cad_source_file_swap.exe');
function fixture(){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-swap-'));fs.mkdirSync(path.join(dataDir,'imports'));fs.mkdirSync(path.join(dataDir,'source-restores','operation'),{recursive:true});return {dataDir,target:path.join(dataDir,'imports','原始来源.step'),stage:path.join(dataDir,'source-restores','operation','candidate.step'),backup:path.join(dataDir,'source-restores','operation','before.step')};}
const finish=({dataDir})=>fs.rmSync(dataDir,{recursive:true,force:true});

test('missing destination validation never creates directories; private artifacts cannot become active sources',async()=>{
  const f=fixture();try{
    const target=path.join(f.dataDir,'project-assets','missing','original.step');assert.equal(managedStepDestination(target,f.dataDir),target);assert.equal(fs.existsSync(path.dirname(target)),false);
    fs.writeFileSync(f.stage,'original');assert.equal(restorationStepPath(f.stage,f.dataDir),f.stage);
    assert.throws(()=>managedStepPath(f.stage,f.dataDir),{code:'PROJECT_SOURCE_UNTRUSTED'});
    assert.deepEqual((await hashRestorationStepSource(f.stage,f.dataDir)).fingerprint,(await (async()=>{fs.writeFileSync(f.target,'original');return hashManagedStepSource(f.target,f.dataDir);})()).fingerprint);
    for(const name of ['source.step:stream.step','CON.step','trailing. /original.step','bad?.step'])assert.throws(()=>managedStepDestination(path.join(f.dataDir,'imports',name),f.dataDir),{code:'PROJECT_SOURCE_UNTRUSTED'});
    fs.linkSync(f.stage,f.backup);assert.throws(()=>restorationStepPath(f.stage,f.dataDir),{code:'PROJECT_SOURCE_UNTRUSTED'});
  }finally{finish(f);}
});

test('a parent link or file is rejected for missing destinations',()=>{
  const f=fixture(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-outside-'));
  try{
    fs.symlinkSync(outside,path.join(f.dataDir,'imports','linked'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>managedStepDestination(path.join(f.dataDir,'imports','linked','missing.step'),f.dataDir),{code:'PROJECT_SOURCE_UNTRUSTED'});
    fs.writeFileSync(path.join(f.dataDir,'imports','file'),'not a directory');assert.throws(()=>managedStepDestination(path.join(f.dataDir,'imports','file','missing.step'),f.dataDir),{code:'PROJECT_SOURCE_UNTRUSTED'});
  }finally{finish(f);fs.rmSync(outside,{recursive:true,force:true});}
});

test('native Windows replacement retains the actual old file and rollback retains the replaced candidate',{skip:process.platform!=='win32'},async()=>{
  assert.ok(fs.existsSync(executablePath),'Build cad_source_file_swap before running native file tests');const f=fixture(),swap=new SourceFileSwap({dataDir:f.dataDir,executablePath});
  try{
    fs.writeFileSync(f.target,'damaged original');fs.writeFileSync(f.stage,'verified original');
    const result=await swap.swap({mode:'replace',target:f.target,stage:f.stage,backup:f.backup});assert.deepEqual(result,{ok:true,version:1,winError:0});assert.equal(fs.readFileSync(f.target,'utf8'),'verified original');assert.equal(fs.readFileSync(f.backup,'utf8'),'damaged original');assert.equal(fs.existsSync(f.stage),false);
    const rollback=path.join(path.dirname(f.stage),'rollback.step'),retained=path.join(path.dirname(f.stage),'replaced.step');fs.copyFileSync(f.backup,rollback,fs.constants.COPYFILE_EXCL);
    assert.equal((await swap.swap({mode:'replace',target:f.target,stage:rollback,backup:retained})).ok,true);assert.equal(fs.readFileSync(f.target,'utf8'),'damaged original');assert.equal(fs.readFileSync(f.backup,'utf8'),'damaged original');assert.equal(fs.readFileSync(retained,'utf8'),'verified original');
    await assert.rejects(swap.swap({mode:'replace',target:f.target,stage:retained,backup:f.backup}),{code:'SOURCE_SWAP_BACKUP_EXISTS'});
  }finally{await swap.close();finish(f);}
});

test('native install never overwrites an appeared target; retire keeps the complete file',{skip:process.platform!=='win32'},async()=>{
  const f=fixture(),swap=new SourceFileSwap({dataDir:f.dataDir,executablePath});
  try{
    fs.writeFileSync(f.stage,'restored');assert.equal((await swap.swap({mode:'install',target:f.target,stage:f.stage})).ok,true);
    fs.writeFileSync(f.stage,'must not win');const collision=await swap.swap({mode:'install',target:f.target,stage:f.stage});assert.equal(collision.ok,false);assert.equal(fs.readFileSync(f.target,'utf8'),'restored');assert.equal(fs.readFileSync(f.stage,'utf8'),'must not win');
    assert.equal((await swap.swap({mode:'retire',target:f.target,backup:f.backup})).ok,true);assert.equal(fs.existsSync(f.target),false);assert.equal(fs.readFileSync(f.backup,'utf8'),'restored');
  }finally{await swap.close();finish(f);}
});

test('timeout requests a stop but retains ownership until actual close; helper receives no provider secrets',async()=>{
  const f=fixture();let child,options;const stopped=new Promise(resolve=>{
    const swap=new SourceFileSwap({dataDir:f.dataDir,executablePath:process.execPath,timeoutMs:10,env:{PATH:process.env.PATH,DEEPSEEK_API_KEY:'not-for-helper'},spawnImpl:(_file,_args,value)=>{
      options=value;child=new EventEmitter();child.pid=12345;child.exitCode=null;child.signalCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;resolve(swap);return true;};return child;
    }});
    fs.writeFileSync(f.stage,'candidate');const running=swap.swap({mode:'install',target:f.target,stage:f.stage});running.catch(()=>{});f.running=running;
  });
  try{
    const swap=await stopped;let settled=false;void f.running.finally(()=>{settled=true;}).catch(()=>{});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(swap.children.size,1);assert.equal(options.env.DEEPSEEK_API_KEY,undefined);assert.equal(options.windowsHide,true);
    await assert.rejects(swap.swap({mode:'install',target:f.target,stage:f.stage}),{code:'SOURCE_SWAP_BUSY'});
    const rejected=assert.rejects(f.running,{code:'SOURCE_SWAP_OUTCOME_UNKNOWN'});child.signalCode='SIGTERM';child.emit('close',null,'SIGTERM');await rejected;assert.equal(swap.children.size,0);await swap.close();
  }finally{if(child?.signalCode===null){child.signalCode='SIGTERM';child.emit('close',null,'SIGTERM');}finish(f);}
});
