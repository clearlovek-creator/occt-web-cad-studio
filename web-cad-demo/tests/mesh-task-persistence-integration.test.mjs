import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("real OCCT/Gmsh result and Body ownership survive a gateway restart without remeshing",async()=>{
  const root=path.resolve(import.meta.dirname,".."),data=fs.mkdtempSync(path.join(os.tmpdir(),"cad-mesh-task-restart-"));
  const api="http://127.0.0.1:8870/api";let gateway;
  async function start(){
    gateway=spawn(process.execPath,["gateway/server.mjs"],{cwd:root,env:{...process.env,GEOMETRY_PORT:"8870",GEOMETRY_DATA_DIR:data},windowsHide:true,stdio:["ignore","pipe","pipe"]});
    await new Promise((resolve,reject)=>{let errors="";const timer=setTimeout(()=>reject(new Error("Gateway startup timeout: "+errors)),20000);gateway.once("error",reject);gateway.stderr.on("data",chunk=>errors+=chunk);gateway.stdout.on("data",chunk=>{if(chunk.includes("Geometry gateway ready")){clearTimeout(timer);resolve();}});});
    // CAD readiness and complete mesh-history recovery are distinct states.
    const deadline=Date.now()+15000;for(;;){const response=await fetch(api+'/mesh/catalog'),result=await response.json();assert.equal(response.status,200);if(result.meshCatalog.state==='ready')break;assert.equal(result.meshCatalog.state,'recovering',JSON.stringify(result));assert.ok(Date.now()<deadline,'Mesh catalog recovery remained unconfirmed');await new Promise(resolve=>setTimeout(resolve,5));}
  }
  async function stop(){if(!gateway)return;const child=gateway;gateway=null;const exit=new Promise(resolve=>child.once("exit",resolve));child.kill();await exit;}
  async function post(url,body){const response=await fetch(api+url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));assert.equal(result.ok,true,JSON.stringify(result));return result;}
  try {
    await start();
    const box=await post("/commands",{documentId:"default",operation:"primitive.box",baseRevision:0,parameters:{width:12,depth:10,height:8}});
    const mesh=await post("/documents/default/mesh/jobs",{}),jobId=mesh.meshJob.jobId;
    assert.equal(mesh.meshJob.state,"complete");assert.equal(mesh.meshJob.freshness.status,"current");
    const original=fs.readFileSync(mesh.mesh.outputPath),mtime=fs.statSync(mesh.mesh.outputPath).mtimeMs;
    const owner=mesh.mesh.render.groups.find(group=>group.bodyId===box.bodyId);assert.ok(owner.bodyIdentity);assert.ok(owner.topologyIdentity);
    assert.equal(mesh.mesh.qualityDiagnostics,true);
    const queryUrl="/mesh/jobs/"+jobId+"/quality?threshold=1&issue=bad&limit=3";
    const diagnostics=await (await fetch(api+queryUrl)).json();assert.equal(diagnostics.ok,true);assert.ok(diagnostics.total>0);assert.equal(diagnostics.cells.length,Math.min(3,diagnostics.total));
    assert.equal(diagnostics.cells[0].corners.length,12);assert.equal(diagnostics.cells[0].bodyIdentities[box.bodyId].bodyIdentity,owner.bodyIdentity);
    assert.equal(diagnostics.quality.histogram.reduce((n,bin)=>n+bin.count,0)+diagnostics.quality.nonFiniteQualityCount+diagnostics.quality.outOfRangeCount,diagnostics.quality.tetraCount);
    assert.equal((await fetch(api+"/mesh/jobs/"+jobId+"/quality?limit=101")).status,400);
    await post("/mesh/jobs/"+jobId+"/visibility",{visible:true});
    await stop();await start();
    const list=await (await fetch(api+"/documents/default/mesh/jobs")).json();assert.equal(list.jobs.length,1);assert.equal(list.jobs[0].state,"complete");assert.equal(list.jobs[0].visible,false);
    const restored=await (await fetch(api+"/mesh/jobs/"+jobId)).json();assert.equal(restored.meshJob.recovered,true);assert.equal(restored.meshJob.freshness.status,"current");assert.equal(restored.meshJob.visible,false);
    const restoredOwner=restored.mesh.render.groups.find(group=>group.bodyId===box.bodyId);assert.equal(restoredOwner.bodyIdentity,owner.bodyIdentity);assert.equal(restoredOwner.topologyIdentity,owner.topologyIdentity);
    assert.deepEqual(fs.readFileSync(restored.mesh.outputPath),original);assert.equal(fs.statSync(restored.mesh.outputPath).mtimeMs,mtime);
    const restoredQuality=await (await fetch(api+queryUrl)).json();assert.deepEqual(restoredQuality.cells,diagnostics.cells);
    assert.deepEqual(restored.mesh.boundaryMapping,mesh.mesh.boundaryMapping,'Face provenance must survive byte-checked result recovery');
    const boundary=await (await fetch(api+'/mesh/jobs/'+jobId+'/boundary')).json();assert.equal(boundary.ok,true);assert.equal(boundary.boundary.complete,true);assert.equal(boundary.boundary.sourceFaces.length,6);
    assert.equal((await post("/mesh/jobs/"+jobId+"/visibility",{visible:true})).meshJob.visible,true);
    const view=await (await fetch(api+"/documents/default")).json();assert.equal(view.revision,box.revision);assert.equal(view.bodyCount,1);
    await post("/commands",{documentId:"default",operation:"primitive.box",baseRevision:box.revision,parameters:{width:2,depth:2,height:2,x:30}});
    const historical=await (await fetch(api+queryUrl)).json();assert.equal(historical.meshJob.freshness.status,"stale");assert.deepEqual(historical.cells,diagnostics.cells);
    const qualityFile=path.join(data,"mesh-jobs","default",jobId,"quality.json");fs.appendFileSync(qualityFile," ");
    const damaged=await fetch(api+queryUrl);assert.equal(damaged.status,409);assert.equal((await damaged.json()).meshJob.state,"failed");assert.equal(fs.existsSync(qualityFile),true);
  } finally {await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(data,{recursive:true,force:true});}
});
