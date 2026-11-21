import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {SourceCheckpointCatalog} from '../gateway/source-checkpoint-catalog.mjs';
import {SnapshotSourceInspector} from '../gateway/snapshot-source-inspector.mjs';
import {SourceRestoreProof} from '../gateway/source-restore-proof.mjs';
import {SourceFileSwap} from '../gateway/source-file-swap.mjs';
import {SourceRestoreTransactions} from '../gateway/source-restore-transactions.mjs';
import {decodeProjectPackage,PROJECT_MIME} from '../gateway/project-package.mjs';
import {stopTestChild} from './helpers/stop-test-child.mjs';

test('actual OCCT snapshots from two projects authorize only original STEP bytes; file repair never rewrites geometry or history',{timeout:60000,skip:process.platform!=='win32'},async()=>{
  const root=path.resolve(import.meta.dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-restore-native-中文-'));
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));const api=`http://127.0.0.1:${port}/api`;
  let gateway,inspector,swap,transactions;
  const json=async(route,body)=>{const response=await fetch(api+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)}),result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));return result;};
  const protectedFiles=()=>{
    const result={},walk=directory=>{if(!fs.existsSync(directory))return;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())walk(file);else result[path.relative(dataDir,file)]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');}};
    for(const directory of ['history','property-schemas'])walk(path.join(dataDir,directory));return result;
  };
  try{
    gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:String(port),GEOMETRY_DATA_DIR:dataDir},windowsHide:true,stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Isolated source restore fixture startup timeout')),15000);gateway.once('error',error=>{clearTimeout(timer);reject(error);});gateway.stdout.on('data',chunk=>{if(String(chunk).includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});gateway.stderr.resume();});
    await json('/commands',{documentId:'source',operation:'primitive.box',parameters:{width:12,depth:15,height:8}});
    const exported=await json('/documents/source/exports/step',{}),step=Buffer.from(await fetch(`http://127.0.0.1:${port}`+exported.downloadUrl).then(response=>response.arrayBuffer()));
    const imported=await fetch(api+'/documents/A/imports/step',{method:'POST',headers:{'content-type':'application/step'},body:step}).then(response=>response.json());assert.equal(imported.ok,true,JSON.stringify(imported));
    const view=await json('/commands',{documentId:'A',operation:'document.view'}),target=view.features.find(feature=>feature.type==='import.step').stringParameters.sourcePath;
    const packageResponse=await fetch(api+'/documents/A/project/save',{method:'POST'});assert.equal(packageResponse.status,200);const geometry=decodeProjectPackage(Buffer.from(await packageResponse.arrayBuffer())).geometry;
    const clone=await fetch(api+'/documents/B/project/open',{method:'POST',headers:{'content-type':PROJECT_MIME},body:geometry}).then(response=>response.json());assert.equal(clone.ok,true,JSON.stringify(clone));
    await stopTestChild(gateway);gateway=null;
    const before=protectedFiles(),original=fs.readFileSync(target),operationId='restore-'+randomUUID(),directory=path.join(dataDir,'source-restores',operationId);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'candidate.step'),original);fs.appendFileSync(target,'\n/* source damage */');
    inspector=new SnapshotSourceInspector({executablePath:path.join(root,'geometry-worker/build/cad_snapshot_source_inspector.exe'),roots:['history','history-quarantine','project-assets','project-transactions'].map(name=>path.join(dataDir,name)),env:{...process.env,PATH:[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',process.env.PATH].join(path.delimiter)}});
    const catalog=new SourceCheckpointCatalog({dataDir}),proof=new SourceRestoreProof({dataDir,catalog,inspector});swap=new SourceFileSwap({dataDir,executablePath:path.join(root,'geometry-worker/build/cad_source_file_swap.exe')});transactions=new SourceRestoreTransactions({dataDir,proof,swap});
    fs.appendFileSync(path.join(directory,'candidate.step'),'\nnot original');await assert.rejects(transactions.prepare({operationId,target}),{code:'SOURCE_RESTORE_CONFLICT'});assert.equal(fs.existsSync(path.join(directory,'record.json')),false);assert.deepEqual(protectedFiles(),before);
    fs.writeFileSync(path.join(directory,'candidate.step'),original);const prepared=await transactions.prepare({operationId,target});assert.deepEqual(prepared.projects,['A','B']);assert.ok(prepared.referenceCount>=2);assert.deepEqual(protectedFiles(),before);
    assert.equal((await transactions.commit(operationId)).state,'committed');assert.deepEqual(fs.readFileSync(target),original);assert.deepEqual(protectedFiles(),before,'Source repair cannot publish or recompute CAD checkpoints');
    const record=transactions.read(operationId);assert.equal(fs.readFileSync(path.join(directory,record.beforeArtifact),'utf8').endsWith('/* source damage */'),true);
    assert.equal((await transactions.rollback(operationId)).state,'rolled-back');assert.equal(fs.readFileSync(target,'utf8').endsWith('/* source damage */'),true);assert.deepEqual(protectedFiles(),before);
  }finally{await stopTestChild(gateway);await transactions?.close();await swap?.close();await inspector?.close();fs.rmSync(dataDir,{recursive:true,force:true});}
});
