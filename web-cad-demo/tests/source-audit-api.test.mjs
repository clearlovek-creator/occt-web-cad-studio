import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {decodeProjectPackage,PROJECT_MIME} from '../gateway/project-package.mjs';
import {stopTestChild} from './helpers/stop-test-child.mjs';

test('read-only source audit resolves actual current/Undo/Redo XBF references, missing bytes and corrupt checkpoints',{timeout:60000},async()=>{
  const root=path.resolve(import.meta.dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-source-api-中文-'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const api=`http://127.0.0.1:${port}/api`;let gateway;
  const start=async()=>{
    let diagnostics='';gateway=spawn(process.execPath,['gateway/server.mjs'],{cwd:root,env:{...process.env,GEOMETRY_PORT:String(port),GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});gateway.stderr.on('data',chunk=>diagnostics+=chunk);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Source audit startup: '+diagnostics)),15000);gateway.once('error',reject);gateway.stdout.on('data',chunk=>{if(String(chunk).includes('Geometry gateway ready')){clearTimeout(timer);resolve();}});});
  };
  const json=async(route,method='GET',body)=>{const response=await fetch(api+route,{method,signal:AbortSignal.timeout(15000),...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});return {status:response.status,payload:await response.json()};};
  const command=async(id,operation='document.view',parameters={},inputs={})=>{
    const summary=await json('/documents/'+id),result=await json('/commands','POST',{documentId:id,operation,parameters,inputs,baseRevision:summary.payload.revision,baseStateToken:summary.payload.stateToken});assert.equal(result.payload.ok,true,JSON.stringify(result.payload));return result.payload;
  };
  const audit=async()=>{let result=await json('/documents/audit/source-audit','POST');assert.equal(result.status,202);for(let count=0;count<200&&['queued','running','stopping'].includes(result.payload.audit?.state);count++){await new Promise(resolve=>setTimeout(resolve,20));result=await json('/documents/audit/source-audit');}assert.equal(result.payload.audit.state,'complete',JSON.stringify(result.payload));return result.payload.audit;};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const disk=()=>{const directory=path.join(data,'history','audit');return Object.fromEntries(fs.readdirSync(directory).filter(name=>name.endsWith('.xbf')||name.endsWith('.json')).map(name=>[name,hash(fs.readFileSync(path.join(directory,name)))]));};
  try{
    await start();assert.equal((await json('/documents/unknown/source-audit')).payload.code,'WORKSPACE_NOT_FOUND');
    await command('source','primitive.box',{width:20,depth:15,height:8,reset:true});
    const exported=await json('/documents/source/exports/step','POST',{});assert.equal(exported.payload.ok,true);
    const step=await fetch(`http://127.0.0.1:${port}`+exported.payload.downloadUrl).then(response=>response.arrayBuffer());
    const imported=await fetch(api+'/documents/audit/imports/step',{method:'POST',headers:{'content-type':'application/step'},body:step}).then(response=>response.json());assert.equal(imported.ok,true,JSON.stringify(imported));
    await command('audit','variable.set',{name:'shift',type:'length',expression:'2 mm'});
    await command('audit','transform.translate',{dx:'shift',dy:0,dz:0},{bodyId:imported.bodyId||imported.activeBodyId});await command('audit','document.undo');
    const before=await command('audit'),beforeDisk=disk(),source=before.features.find(feature=>feature.type==='import.step').stringParameters.sourcePath,original=fs.readFileSync(source);
    const portable=await fetch(api+'/documents/audit/project/save',{method:'POST'});assert.equal(portable.status,200);const rawSnapshot=decodeProjectPackage(Buffer.from(await portable.arrayBuffer())).geometry;
    const report=await audit();assert.equal(report.integrityOK,true);assert.equal(report.coverageComplete,true);assert.equal(report.assets.length,1);assert.ok(report.assets[0].undoReferences>0);assert.ok(report.assets[0].redoReferences>0);assert.equal(report.assets[0].currentReferences,1);
    assert.equal(JSON.stringify(report).includes(data),false);assert.equal(report.cleanupAvailable,false);assert.equal((await command('audit')).stateToken,before.stateToken);assert.deepEqual(disk(),beforeDisk);
    fs.appendFileSync(source,'\n/* altered */');const stale=(await json('/documents/audit/source-audit')).payload.audit;assert.equal(stale.stale,true);assert.equal(stale.integrityOK,false);
    assert.equal((await audit()).assets[0].status,'changed');assert.equal((await command('audit')).stateToken,before.stateToken);
    fs.renameSync(source,source+'.retained');assert.equal((await audit()).assets[0].status,'missing');fs.renameSync(source+'.retained',source);fs.writeFileSync(source,original);
    await command('audit','body.delete',{}, {bodyId:imported.bodyId||imported.activeBodyId});
    const empty=await command('audit');assert.equal(empty.bodyCount,0);const retained=await audit();assert.equal(retained.assets.length,1);assert.equal(retained.assets[0].currentReferences,0);assert.ok(retained.assets[0].undoReferences>0,'Source must remain tracked through real Undo checkpoints');
    const manifest=JSON.parse(fs.readFileSync(path.join(data,'history','audit','manifest.json'),'utf8'));const damaged=path.join(data,'history','audit',manifest.undo[0]),saved=fs.readFileSync(damaged);fs.appendFileSync(damaged,'modified checkpoint');
    const incomplete=await audit();assert.equal(incomplete.coverageComplete,false);assert.equal(incomplete.integrityOK,false);assert.ok(incomplete.issues.some(issue=>issue.code==='SOURCE_SNAPSHOT_CHECKSUM'));fs.writeFileSync(damaged,saved);
    assert.equal((await command('audit')).stateToken,empty.stateToken);assert.equal(fs.existsSync(source),true,'No audit may clean a referenced file');
    await stopTestChild(gateway);gateway=null;await start();assert.equal((await json('/documents/audit/source-audit')).payload.audit,null,'Reports are ephemeral and must not auto-replay after restart');assert.equal((await audit()).integrityOK,true);
    await stopTestChild(gateway);gateway=null;
    const missingUndoManifest=JSON.parse(fs.readFileSync(path.join(data,'history','audit','manifest.json'),'utf8')),missingUndo=path.join(data,'history','audit',missingUndoManifest.undo[0]),missingUndoBytes=fs.readFileSync(missingUndo);fs.rmSync(missingUndo);const missingBefore=disk();
    await start();const missingUndoReport=await audit();assert.equal(missingUndoReport.coverageComplete,false);assert.ok(missingUndoReport.issues.some(issue=>issue.checkpoint?.includes(path.basename(missingUndo))),'Missing Undo references cannot disappear through loader filtering');assert.deepEqual(disk(),missingBefore);fs.writeFileSync(missingUndo,missingUndoBytes);
    // A diagnostic must never enter lazy document restore and silently recover
    // an older timeline when the current checkpoint is corrupt.
    await stopTestChild(gateway);gateway=null;
    const currentManifest=JSON.parse(fs.readFileSync(path.join(data,'history','audit','manifest.json'),'utf8'));
    const currentPath=path.join(data,'history','audit',currentManifest.current);fs.appendFileSync(currentPath,'corrupt current checkpoint');const protectedBefore=disk();
    await start();const diagnosed=await audit();assert.equal(diagnosed.coverageComplete,false);assert.deepEqual(disk(),protectedBefore,'A source diagnostic must not restore, quarantine, clean, or rewrite any history');
    // A raw legacy copy retains the same managed STEP path, unlike a portable
    // package which intentionally installs independent source assets.
    const clone=await fetch(api+'/documents/clone/project/open',{method:'POST',headers:{'content-type':PROJECT_MIME},body:rawSnapshot}).then(response=>response.json());assert.equal(clone.ok,true,JSON.stringify(clone));
    const cloneManifestPath=path.join(data,'history','clone','manifest.json'),cloneManifestBytes=fs.readFileSync(cloneManifestPath),cloneManifest=JSON.parse(cloneManifestBytes),cloneSnapshot=fs.readFileSync(path.join(data,'history','clone',cloneManifest.current));
    const quarantine=path.join(data,'history-quarantine','clone');fs.mkdirSync(quarantine,{recursive:true});fs.writeFileSync(path.join(quarantine,cloneManifest.current+'-'+hash(cloneSnapshot)+'.corrupt'),cloneSnapshot);
    const backupName='clone-11111111-1111-1111-1111-111111111111.manifest.json',backup=path.join(data,'document-transactions',backupName);fs.linkSync(cloneManifestPath,backup);
    const journal=path.join(data,'document-transactions','clone.pending.json');fs.writeFileSync(journal,JSON.stringify({version:2,phase:'prepared',documentId:'clone',beforeManifest:{file:backupName,bytes:cloneManifestBytes.length,sha256:hash(cloneManifestBytes)}}));
    fs.writeFileSync(path.join(data,'imports','retained.step'),'retained source with no known reference');const storageBefore=disk(),journalBefore=fs.readFileSync(journal);
    let storage=await json('/source-catalog','POST');assert.equal(storage.status,202);for(let count=0;count<300&&['queued','running','stopping'].includes(storage.payload.audit.state);count++){await new Promise(resolve=>setTimeout(resolve,20));storage=await json('/source-catalog');}
    const inventory=storage.payload.audit;assert.equal(inventory.state,'complete',JSON.stringify(inventory));assert.equal(inventory.scope,'storage');assert.equal(inventory.cleanupAvailable,false);const shared=inventory.assets.find(item=>item.fileName===path.basename(source));
    assert.equal(shared.projectCount,2);assert.deepEqual(new Set(shared.projects),new Set(['audit','clone']));assert.ok(shared.recoveryReferences>0);assert.ok(shared.quarantineReferences>0);assert.equal(inventory.assets.find(item=>item.fileName==='retained.step').status,'unreferenced');assert.equal(inventory.coverageComplete,false,'The corrupt retained checkpoint must remain visible to global coverage');assert.equal(JSON.stringify(inventory).includes(data),false);
    assert.deepEqual(disk(),storageBefore);assert.deepEqual(fs.readFileSync(journal),journalBefore,'Storage diagnosis must not execute a pending recovery transaction');assert.deepEqual(fs.readFileSync(cloneManifestPath),cloneManifestBytes);
  }finally{await stopTestChild(gateway);assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
});
