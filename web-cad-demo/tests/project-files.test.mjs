import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {decodeProjectPackage,encodeProjectPackage,PROJECT_MIME} from "../gateway/project-package.mjs";
import {readManagedStepSource} from '../gateway/step-source-integrity.mjs';
const root=fileURLToPath(new URL("../",import.meta.url));
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function start(directory,port){
  let diagnostics="";const child=spawn(process.execPath,["gateway/server.mjs"],{cwd:root,env:{...process.env,GEOMETRY_PORT:String(port),GEOMETRY_DATA_DIR:directory},windowsHide:true,stdio:["ignore","pipe","pipe"]});
  child.stderr.on("data",chunk=>diagnostics+=chunk);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Project test gateway startup failed: ${diagnostics}`)),15000);child.once("error",reject);child.stdout.on("data",chunk=>{if(chunk.includes("Geometry gateway ready")){clearTimeout(timer);resolve();}});});return child;
}
async function stop(child){if(!child || child.exitCode!==null || child.signalCode!==null)return;await new Promise(resolve=>{child.once("exit",resolve);child.kill();});}

test("portable project preserves typed instances and STEP replay across gateways; corrupt opens roll back",{timeout:60000},async()=>{
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"cad-project-integration-")), aDir=path.join(scratch,"A-工程"), bDir=path.join(scratch,"B-工程");
  const aPort=await freePort(),bPort=await freePort();let a,b;
  const request=async(port,route,body,contentType="application/json")=>{
    const response=await fetch(`http://127.0.0.1:${port}/api${route}`,{method:"POST",signal:AbortSignal.timeout(15000),headers:{"Content-Type":contentType},body:contentType==="application/json" ? JSON.stringify(body) : body});
    return {response,payload:await response.json()};
  };
  const command=async(port,documentId,operation,parameters={},inputs={})=>{const summary=await (await fetch(`http://127.0.0.1:${port}/api/documents/${documentId}`)).json();const {payload}=await request(port,"/commands",{protocolVersion:1,documentId,baseRevision:summary.revision,baseStateToken:summary.stateToken,operation,parameters,inputs});assert.equal(payload.ok,true,JSON.stringify(payload));return payload;};
  try {
    a=await start(aDir,aPort);b=await start(bDir,bPort);
    await command(aPort,"source","primitive.box",{width:20,depth:12,height:5,reset:true});
    const exported=await request(aPort,"/documents/source/exports/step",{});assert.equal(exported.payload.ok,true);
    const step=await (await fetch(`http://127.0.0.1:${aPort}${exported.payload.downloadUrl}`)).arrayBuffer();
    const imported=await request(aPort,"/documents/portable/imports/step",step,"application/step");assert.equal(imported.payload.ok,true);
    await command(aPort,"portable","variable.set",{name:"shift",type:"length",expression:"4 mm"});
    const transformed=await command(aPort,"portable","transform.translate",{dx:"shift",dy:0,dz:0},{bodyId:imported.payload.bodyId || imported.payload.activeBodyId});
    await command(aPort,"portable","body.update",{name:"基板 中文"},{bodyId:transformed.bodyId});
    await command(aPort,"portable","coordinate.set",{id:"local_cn",name:"本地坐标系",kind:"cartesian",origin:[1,2,3],xAxis:[1,0,0],yAxis:[0,1,0]});
    const type=await command(aPort,"portable","property.type.create",{key:"Setup",fields:[{key:"frequency",type:"double"},{key:"enabled",type:"bool"},{key:"modes",type:"int"},{key:"offset",type:"expression"},{key:"axis",type:"vector3"},{key:"kind",type:"enum",options:["A","B"]}]});
    const renamed=await request(aPort,"/projects/portable",{name:"便携工程 中文"});assert.equal(renamed.payload.ok,true);
    const value={frequency:3,enabled:true,modes:2,offset:"shift / 2",axis:[1,0,0],kind:"A"};
    const instance=await command(aPort,"portable","property.instance.create",{typeId:type.type.typeId,name:"Setup 1",value});
    const portType=await command(aPort,"portable","property.type.create",{key:"WavePort",targetScope:"face",association:"required",fields:[{key:"mode",type:"int"}]});
    const presentation=await command(aPort,"portable","body.presentation",{}, {bodyId:transformed.bodyId});
    const faceInstance=await command(aPort,"portable","property.instance.create",{typeId:portType.type.typeId,name:"Port 1",value:{mode:1},target:{kind:"face",bodyId:transformed.bodyId,topologyId:presentation.triangleFaceIds[0],topologyRevision:presentation.topologyRevision}});
    const saved=await fetch(`http://127.0.0.1:${aPort}/api/documents/portable/project/save`,{method:"POST"});assert.equal(saved.status,200,await saved.clone().text());assert.equal(saved.headers.get("content-type"),PROJECT_MIME);
    const bytes=Buffer.from(await saved.arrayBuffer()),unpacked=decodeProjectPackage(bytes);assert.equal(unpacked.sources.length,1);
    const sourceView=await command(aPort,"portable","document.view");const originalPath=sourceView.features.find(feature=>feature.type==="import.step").stringParameters.sourcePath;
    const nativeProof=sourceView.features.find(feature=>feature.type==='import.step').stringParameters.sourceFingerprint;
    assert.equal(readManagedStepSource(originalPath,aDir).fingerprint,nativeProof,'Gateway hashing must agree with the actual native import proof');
    const originalStep=fs.readFileSync(originalPath);fs.appendFileSync(originalPath,'\n/* changed */');
    const changedSave=await fetch(`http://127.0.0.1:${aPort}/api/documents/portable/project/save`,{method:'POST'});assert.equal(changedSave.status,400);assert.equal((await changedSave.json()).code,'PROJECT_SOURCE_CHANGED');
    fs.writeFileSync(originalPath,originalStep);assert.equal((await command(aPort,'portable','document.view')).stateToken,sourceView.stateToken,'A failed save must not change geometry or project state');
    await command(bPort,"destination","primitive.sphere",{radius:80,reset:true});await command(bPort,"destination","property.type.create",{key:"DiscardMe",fields:[]});
    const beforeOpen=await command(bPort,'destination','document.view');
    for(const [sources,code] of [
      [[{...unpacked.sources[0],bytes:Buffer.concat([unpacked.sources[0].bytes,Buffer.from('\n/* swapped source */')])}],'PROJECT_SOURCE_CHANGED'],
      [[],'PROJECT_SOURCE_BINDINGS_MISMATCH'],
      [[{...unpacked.sources[0],featureId:'feature-not-the-import'}],'PROJECT_SOURCE_BINDINGS_MISMATCH'],
    ]){
      const altered=await request(bPort,'/documents/destination/project/open',encodeProjectPackage({...unpacked,sources}),PROJECT_MIME);
      assert.equal(altered.payload.ok,false);assert.equal(altered.payload.code,code,JSON.stringify(altered.payload));
      assert.equal((await command(bPort,'destination','document.view')).stateToken,beforeOpen.stateToken);
      assert.equal((await command(bPort,'destination','property.type.list')).types.some(item=>item.key==='DiscardMe'),true);
      assert.equal(fs.readdirSync(path.join(bDir,'project-assets')).length,0,'Preflight failures must discard only their private staging files');
    }
    const opened=await request(bPort,"/documents/destination/project/open",bytes,PROJECT_MIME);assert.equal(opened.payload.ok,true,JSON.stringify(opened.payload));assert.equal(opened.payload.projectFile.sourceCount,1);
    const workspace=await (await fetch(`http://127.0.0.1:${bPort}/api/projects/destination`)).json();assert.equal(workspace.project.name,"便携工程 中文");assert.equal(workspace.project.hasChangesSinceExport,false);
    assert.equal(opened.payload.bodyMetadata.find(item=>item.bodyId===transformed.bodyId || item.id===transformed.bodyId).name,"基板 中文");
    assert.equal(opened.payload.coordinateSystems.find(item=>item.id==="local_cn").name,"本地坐标系");
    assert.equal(opened.payload.propertySchema.instances.find(item=>item.instanceId===instance.instance.instanceId).value.frequency,3);
    assert.deepEqual(opened.payload.propertySchema.instances.find(item=>item.instanceId===faceInstance.instance.instanceId).target,faceInstance.instance.target);
    assert.equal(opened.payload.propertySchema.types.some(item=>item.key==="DiscardMe"),false);
    await stop(a);a=null;assert.ok(path.resolve(originalPath).startsWith(path.resolve(aDir)+path.sep));fs.rmSync(originalPath);
    await command(bPort,"destination","variable.set",{name:"shift",type:"length",expression:"9 mm"});
    const before=await command(bPort,"destination","document.view");const rebound=before.features.find(feature=>feature.type==="import.step").stringParameters.sourcePath;
    assert.ok(path.resolve(rebound).startsWith(path.resolve(bDir,"project-assets")+path.sep));assert.ok(fs.existsSync(rebound));
    const checkUnchanged=async()=>{const view=await command(bPort,"destination","document.view");assert.equal(view.revision,before.revision);assert.equal(view.bodyCount,before.bodyCount);const schema=await command(bPort,"destination","property.instance.list");assert.deepEqual(schema.instances.find(item=>item.instanceId===instance.instance.instanceId).value,value);};
    const damaged=Buffer.from(bytes);damaged[15]^=1;const bad=await request(bPort,"/documents/destination/project/open",damaged,PROJECT_MIME);assert.equal(bad.payload.ok,false);await checkUnchanged();
    const invalidSchema=structuredClone(unpacked.propertySchema);invalidSchema.instances.find(item=>item.instanceId===instance.instance.instanceId).value.enabled="yes";
    assert.throws(()=>encodeProjectPackage({...unpacked,propertySchema:invalidSchema}),/矛盾/);
    const badSchema=await request(bPort,"/documents/destination/project/open",encodeProjectPackage({...unpacked,propertySchema:invalidSchema,projectData:{...unpacked.projectData,propertySchema:invalidSchema}}),PROJECT_MIME);assert.equal(badSchema.payload.ok,false);await checkUnchanged();
    const invalidGeometry=encodeProjectPackage({...unpacked,geometry:Buffer.from("BINFILE"+"z".repeat(128))});
    const badGeometry=await request(bPort,"/documents/destination/project/open",invalidGeometry,PROJECT_MIME);assert.equal(badGeometry.payload.ok,false);await checkUnchanged();
    await stop(b);b=await start(bDir,bPort);await checkUnchanged();
    await command(bPort,"destination","variable.set",{name:"shift",type:"length",expression:"11 mm"});
    const secondSave=await fetch(`http://127.0.0.1:${bPort}/api/documents/destination/project/save`,{method:"POST"});assert.equal(secondSave.status,200);assert.equal(decodeProjectPackage(Buffer.from(await secondSave.arrayBuffer())).sources.length,1);
    const legacy=await request(bPort,"/documents/legacy/project/open",unpacked.geometry,"application/x-occt-xbf");
    assert.equal(legacy.payload.ok,true);assert.equal(legacy.payload.projectFile.format,"legacy-xbf");assert.equal(legacy.payload.propertySchema.instances.length,0);assert.ok(legacy.payload.warnings.some(message=>message.includes("旧版 XBF")));
  } finally {
    await stop(a);await stop(b);const resolved=path.resolve(scratch);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith("cad-project-integration-"));fs.rmSync(resolved,{recursive:true,force:true});
  }
});
