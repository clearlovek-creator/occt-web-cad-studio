import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {MeshWorkerClient} from "../gateway/mesh-worker-client.mjs";

function fixture(){
  const nodes=[],elements=[];
  const add=(id,type,points)=>{const ids=points.map(point=>{nodes.push(point);return nodes.length;});elements.push(`${id} ${type} 2 1 ${type===11?2:1} ${ids.join(" ")}`);};
  const linear=(x,z=1)=>[[x,0,0],[x+1,0,0],[x,1,0],[x,0,z]];
  add("101",4,linear(0));
  const inverted=linear(3);[inverted[1],inverted[2]]=[inverted[2],inverted[1]];add("102",4,inverted);
  add("103",4,linear(6,1e-7));
  add("104",4,[[9,0,0],[10,0,0],[9,1,0],[9.2,.2,0]]);
  const quadratic=x=>[...linear(x),[x+.5,0,0],[x+.5,.5,0],[x,.5,0],[x,0,.5],[x,.5,.5],[x+.5,0,.5]];
  add("201",11,quadratic(12));const curved=quadratic(15);curved[4][2]=2;add("202",11,curved);
  add("301",5,[[18,0,0],[19,0,0],[19,1,0],[18,1,0],[18,0,1],[19,0,1],[19,1,1],[18,1,1]]);
  return `$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$Nodes\n${nodes.length}\n${nodes.map((p,i)=>`${i+1} ${p.join(" ")}`).join("\n")}\n$EndNodes\n$Elements\n${elements.length}\n${elements.join("\n")}\n$EndElements\n`;
}
test("native quality distinguishes inverted, degenerate, sliver and curved tetrahedra with exact element IDs",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cad-quality-native-中文-")),input=path.join(root,"quality.msh"),indexFile=path.join(root,"quality.json");fs.writeFileSync(input,fixture());
  const workerPath=process.env.MESH_WORKER_PATH||path.resolve("mesh-worker/build-gmsh/gmsh_mesh_worker.exe");
  const worker=new MeshWorkerClient({workerPath,runtimePath:"C:/msys64/ucrt64/bin"});
  try {
    const result=await worker.request({protocolVersion:1,requestId:"quality-fixture",operation:"mesh.quality",parameters:{inputPath:input,qualityOutputPath:indexFile}});
    assert.equal(result.ok,true,JSON.stringify(result));const quality=result.quality;
    const index=JSON.parse(fs.readFileSync(indexFile)),byId=new Map(index.cells.map(cell=>[cell.elementId,cell]));
    assert.equal(quality.tetraCount,6,JSON.stringify({quality,cells:index.cells.map(c=>({id:c.elementId,type:c.elementType,order:c.order}))}));assert.equal(quality.unsupportedElementCount,1);assert.equal(quality.status,"partial");
    assert.ok(byId.has("101"));assert.equal(byId.get("102").inverted,true);
    assert.equal(byId.get("104").inverted,false);assert.equal(byId.get("104").degenerate,true);
    assert.equal(byId.get("103").inverted,false);assert.equal(byId.get("103").degenerate,false);assert.ok(byId.get("103").quality<.2);
    assert.equal(byId.get("201").order,2);assert.equal(byId.get("201").inverted,false);assert.equal(byId.get("202").inverted,true);
    assert.ok(quality.invertedCount>=2);assert.ok(quality.degenerateCount>=1);
    assert.equal(quality.histogram.reduce((sum,bin)=>sum+bin.count,0),quality.finiteCount);
    const finite=index.cells.filter(cell=>cell.quality!==null);assert.ok(Math.abs(quality.averageQuality-finite.reduce((sum,cell)=>sum+cell.quality,0)/finite.length)<1e-12);
    assert.ok(index.positions.every(value=>value===null||Number.isFinite(value)));
    const generic=await worker.request({protocolVersion:1,requestId:"volume-metric",operation:"mesh.quality",parameters:{inputPath:input,qualityName:"volume",qualityThreshold:2}});
    assert.equal(generic.quality.qualityName,"volume");assert.equal(generic.quality.tetraCount,6,"File-level alternate metrics remain supported");
    const mixed=path.join(root,"mixed-region.msh");fs.writeFileSync(mixed,fixture().replace(/ 11 2 1 2 /g," 11 2 1 1 "));
    await assert.rejects(worker.request({protocolVersion:1,requestId:"reject-truncated-input",operation:"mesh.quality",parameters:{inputPath:mixed}}),/did not preserve all elements/);
    const huge=path.join(root,"legacy-large-id.msh");fs.writeFileSync(huge,fixture().replace("101 4 2","9007199254740993 4 2"));
    await assert.rejects(worker.request({protocolVersion:1,requestId:"reject-lossy-id",operation:"mesh.quality",parameters:{inputPath:huge}}),/did not preserve element identities/);
    const modern=path.join(root,"modern-large-id.msh");fs.writeFileSync(modern,"$MeshFormat\n4.1 0 8\n$EndMeshFormat\n$Entities\n0 0 0 1\n1 0 0 0 1 1 1 0 0\n$EndEntities\n$Nodes\n1 4 1 4\n3 1 0 4\n1\n2\n3\n4\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n$EndNodes\n$Elements\n1 1 9007199254740993 9007199254740993\n3 1 4 1\n9007199254740993 1 2 3 4\n$EndElements\n");
    await assert.rejects(worker.request({protocolVersion:1,requestId:"modern-lossy-identity",operation:"mesh.quality",parameters:{inputPath:modern,qualityOutputPath:indexFile}}),/did not preserve the element identity range/);
    fs.writeFileSync(modern,fs.readFileSync(modern,"utf8").replaceAll("9007199254740993","2147483646"));
    const modernResult=await worker.request({protocolVersion:1,requestId:"modern-identity",operation:"mesh.quality",parameters:{inputPath:modern,qualityOutputPath:indexFile}});assert.equal(modernResult.quality.tetraCount,1);assert.equal(JSON.parse(fs.readFileSync(indexFile)).cells[0].elementId,"2147483646");
  } finally {await worker.closeAndWait();fs.rmSync(root,{recursive:true,force:true});}
});

test("saved MSH element IDs, corner coordinates and quality agree with the generated diagnostic index",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cad-quality-export-中文-")),input=path.join(root,"box.geo"),output=path.join(root,"box.msh"),first=path.join(root,"created.json"),second=path.join(root,"reloaded.json");
  fs.writeFileSync(input,'SetFactory("OpenCASCADE"); Box(1)={0,0,0,2,3,4}; Mesh.MeshSizeMin=1; Mesh.MeshSizeMax=1;');
  const worker=new MeshWorkerClient({workerPath:process.env.MESH_WORKER_PATH||path.resolve("mesh-worker/build-gmsh/gmsh_mesh_worker.exe"),runtimePath:"C:/msys64/ucrt64/bin"});
  try {
    const mesh=await worker.request({protocolVersion:1,requestId:"created-quality",operation:"mesh.create",parameters:{inputPath:input,outputPath:output,qualityOutputPath:first}});
    const reopened=await worker.request({protocolVersion:1,requestId:"reloaded-quality",operation:"mesh.quality",parameters:{inputPath:output,qualityOutputPath:second}});
    const a=JSON.parse(fs.readFileSync(first)),b=JSON.parse(fs.readFileSync(second)),byId=new Map(b.cells.map(cell=>[cell.elementId,cell]));
    assert.ok(a.cells.length>0);assert.equal(a.cells.length,b.cells.length);assert.equal(mesh.mesh.quality.tetraCount,reopened.quality.tetraCount);
    for(const cell of a.cells){const actual=byId.get(cell.elementId);assert.ok(actual,'Saved file lost element '+cell.elementId);assert.ok(Math.abs(cell.quality-actual.quality)<1e-10);
      const expectedCorners=cell.corners.flatMap(n=>a.positions.slice(n*3,n*3+3)),actualCorners=actual.corners.flatMap(n=>b.positions.slice(n*3,n*3+3));expectedCorners.forEach((value,i)=>assert.ok(Math.abs(value-actualCorners[i])<1e-10));}
  } finally {await worker.closeAndWait();fs.rmSync(root,{recursive:true,force:true});}
});
