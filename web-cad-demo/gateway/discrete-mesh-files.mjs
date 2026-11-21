import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {adaptDiscreteTetraMesh} from './discrete-mesh-adapter.mjs';
import {cadTetraMesh,cadTetraSurfaceRows} from './cad-discrete-tetra.mjs';
import {sealMeshRender,MESH_RENDER_LIMITS,validateMeshRender} from './mesh-render-store.mjs';
export const DISCRETE_MESH_FILE_LIMITS=Object.freeze({mesh:128*1024**2,quality:128*1024**2,render:128*1024**2,manifest:16*1024**2});
const fault=(code,message,details)=>Object.assign(Error(message),{code,...details&&{details}});
function emptyDirectory(directory){
  directory=path.resolve(directory);
  for(let current=directory;;current=path.dirname(current)){const st=fs.lstatSync(current);if(!st.isDirectory()||st.isSymbolicLink())throw fault('MESH_ARTIFACT_INVALID','离散网格暂存目录不能经过链接。');if(path.dirname(current)===current)break;}
  if(fs.readdirSync(directory).length)throw fault('MESH_ARTIFACT_INVALID','离散网格只能写入空的专属暂存目录，未覆盖原文件。');return directory;
}
function writer(file,limit){
  const fd=fs.openSync(file,'wx'),digest=crypto.createHash('sha256');let bytes=0,closed=false;
  return {get bytes(){return bytes;},write(value){const buffer=Buffer.isBuffer(value)?value:Buffer.from(value);if(bytes+buffer.length>limit)throw fault('MESH_ARTIFACT_LIMIT','离散网格派生文件超过保存预算，未发布结果。');let offset=0;while(offset<buffer.length){const n=fs.writeSync(fd,buffer,offset,buffer.length-offset);if(!n)throw fault('MESH_ARTIFACT_INVALID','网格文件写入不完整。');offset+=n;}bytes+=buffer.length;digest.update(buffer);},finish(){fs.fsyncSync(fd);fs.closeSync(fd);closed=true;return {bytes,sha256:digest.digest('hex')};},close(){if(!closed){fs.closeSync(fd);closed=true;}}};
}
function writeFile(file,limit,action){const out=writer(file,limit);try{action(out);return out.finish();}finally{out.close();}}
function hashFileContents(_name,limit,action){
  const hash=crypto.createHash('sha256');let bytes=0;
  action({get bytes(){return bytes;},write(value){const buffer=Buffer.isBuffer(value)?value:Buffer.from(value);bytes+=buffer.length;if(bytes>limit)throw fault('MESH_ARTIFACT_LIMIT','离散网格派生内容超过预算，未接纳结果。');hash.update(buffer);}});
  return {bytes,sha256:hash.digest('hex')};
}
const box=(nodes,points)=>{const result=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];for(const n of nodes)for(let axis=0;axis<3;axis++){result[axis]=Math.min(result[axis],points[n][axis]);result[axis+3]=Math.max(result[axis+3],points[n][axis]);}return result;};
const sub=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
function physicalName(value){if(!/^[A-Za-z0-9_:/.-]+$/.test(value))throw fault('MESH_DISCRETE_PROJECTION_INVALID','MSH 物理组名称包含不支持的身份字符。');return '"'+value+'"';}
function writeMsh(write,projection,result){
  const output=cadTetraMesh(result),boundaries=cadTetraSurfaceRows(result),partition=result.partition,mesh=projection.mesh,physical=[],surfaceElementCount=boundaries.reduce((n,b)=>n+b.triangles.length,0);
  const bodyTags=new Map(),sheetBodyTags=new Map(),solidTags=new Map(),faceTags=new Map(),solidBodies=new Set(mesh.sourceInventory.sourceSolids.map(s=>s.bodyId)),sheetFaces=new Set((mesh.sourceInventory.sourceSheetFaces||[]).map(f=>f.bodyId+'/'+f.cadFaceId));
  for(const body of projection.source.bodies)if(solidBodies.has(body.bodyId)){const tag=bodyTags.size+1;bodyTags.set(body.bodyId,tag);physical.push({dimension:3,tag,name:'body:'+body.bodyId,bodyId:body.bodyId});}
  for(const body of projection.source.bodies)if((mesh.sourceInventory.sourceSheetFaces||[]).some(f=>f.bodyId===body.bodyId)){const tag=sheetBodyTags.size+1;sheetBodyTags.set(body.bodyId,tag);physical.push({dimension:2,tag,name:'body:'+body.bodyId,bodyId:body.bodyId});}
  for(const solid of mesh.sourceInventory.sourceSolids){const tag=bodyTags.size+solidTags.size+1;solidTags.set(solid.sourceSolidIndex,tag);physical.push({dimension:3,tag,name:'solid:'+solid.bodyId+'/'+solid.solidId,bodyId:solid.bodyId,sourceSolidId:solid.solidId});}
  for(const face of mesh.boundaryMapping.sourceFaces){if(!face.surfaceTags.length)continue;const tag=sheetBodyTags.size+faceTags.size+1,key=face.source.bodyId+'/'+face.source.cadFaceId;faceTags.set(key,tag);physical.push({dimension:2,tag,name:'face:'+key,bodyId:face.source.bodyId,cadFaceId:face.source.cadFaceId});}
  const classify=Array(output.points.length),nodesByEntity=new Map();
  for(const [i,boundary]of boundaries.entries())for(const n of boundary.triangles.flat())if(!classify[n])classify[n]={dimension:2,tag:i+1};
  for(const cell of output.cells)for(const tet of cell.tetrahedra)for(const n of tet)if(!classify[n])classify[n]={dimension:3,tag:cell.cellIndex+1};
  for(let n=0;n<classify.length;n++){const entity=classify[n];if(!entity)throw fault('MESH_DISCRETE_PROJECTION_INVALID','输出包含未使用节点，不能猜测 MSH 分类。');const key=entity.dimension+'/'+entity.tag;if(!nodesByEntity.has(key))nodesByEntity.set(key,{...entity,nodes:[]});nodesByEntity.get(key).nodes.push(n);}
  const proof=write('mesh.msh',DISCRETE_MESH_FILE_LIMITS.mesh,out=>{
    const line=value=>out.write(value+'\n');line('$MeshFormat\n4.1 0 8\n$EndMeshFormat');line('$PhysicalNames');line(String(physical.length));for(const row of physical)line(`${row.dimension} ${row.tag} ${physicalName(row.name)}`);line('$EndPhysicalNames');
    line('$Entities');line(`0 0 ${boundaries.length} ${output.cells.length}`);
    for(const [i,boundary]of boundaries.entries()){
      const surface=mesh.boundaryMapping.surfaces[i],sheetTags=[...new Set(surface.sources.filter(row=>sheetFaces.has(row.bodyId+'/'+row.cadFaceId)).map(row=>sheetBodyTags.get(row.bodyId)))],tags=[...surface.sources.map(row=>faceTags.get(row.bodyId+'/'+row.cadFaceId)),...sheetTags];line(`${i+1} ${box(boundary.triangles.flat(),output.points).join(' ')} ${tags.length} ${tags.join(' ')} 0`);
    }
    for(const cell of output.cells){
      const inventory=mesh.sourceInventory.cells[cell.cellIndex],tags=[...inventory.bodyIds.map(id=>bodyTags.get(id)),...inventory.sourceSolidIndexes.map(i=>solidTags.get(i))];
      const surfaces=boundaries.flatMap((row,i)=>{const use=row.cellUses.find(use=>use.cellIndex===cell.cellIndex);return use?[use.orientation*(i+1)]:[];});
      line(`${cell.cellIndex+1} ${box(cell.tetrahedra.flat(),output.points).join(' ')} ${tags.length} ${tags.join(' ')} ${surfaces.length} ${surfaces.join(' ')}`);
    }
    line('$EndEntities');line('$Nodes');line(`${nodesByEntity.size} ${output.points.length} 1 ${output.points.length}`);
    for(const entity of nodesByEntity.values()){line(`${entity.dimension} ${entity.tag} 0 ${entity.nodes.length}`);for(const n of entity.nodes)line(String(n+1));for(const n of entity.nodes)line(output.points[n].join(' '));}
    line('$EndNodes');line('$Elements');const count=surfaceElementCount+output.report.tetraCount;line(`${boundaries.length+output.cells.length} ${count} 1 ${count}`);let id=0;
    for(const [i,boundary]of boundaries.entries()){
      const reference=boundary.normalReference||{triangleIndex:i,orientation:1};
      line(`2 ${i+1} 2 ${boundary.triangles.length}`);const original=partition.triangles[reference.triangleIndex].map(n=>partition.points[n]),normal=cross(sub(original[1],original[0]),sub(original[2],original[0])).map(v=>v*reference.orientation);
      for(const triangle of boundary.triangles){const p=triangle.map(n=>output.points[n]),nodes=dot(normal,cross(sub(p[1],p[0]),sub(p[2],p[0])))>0?triangle:[triangle[0],triangle[2],triangle[1]];line(`${++id} ${nodes.map(n=>n+1).join(' ')}`);}
    }
    let index=0;for(const cell of output.cells){line(`3 ${cell.cellIndex+1} 4 ${cell.tetrahedra.length}`);for(const tet of cell.tetrahedra){if(projection.index.cells[index++].elementId!==String(++id))throw fault('MESH_DISCRETE_PROJECTION_INVALID','MSH 与质量索引的单元身份不一致。');line(`${id} ${tet.map(n=>n+1).join(' ')}`);}}
    line('$EndElements');
  });return {proof,physicalGroups:physical};
}
function writeRender(write,projection,result,file){
  const wires=[],output=cadTetraMesh(result),boundaries=cadTetraSurfaceRows(result),chunkBytes=Math.floor(MESH_RENDER_LIMITS.chunkBytes/48)*48;
  const proof=write('render.bin',DISCRETE_MESH_FILE_LIMITS.render,out=>{
    const wire=(dimension,tag,elements,edges)=>{
      const seen=new Set(),chunks=[],buffer=Buffer.allocUnsafe(chunkBytes);let fill=0,scalars=0;
      const flush=()=>{if(!fill)return;const chunk=buffer.subarray(0,fill),offset=out.bytes;out.write(chunk);chunks.push({offset,bytes:fill,sha256:crypto.createHash('sha256').update(chunk).digest('hex')});fill=0;};
      for(const nodes of elements)for(const [i,j]of edges){const a=Math.min(nodes[i],nodes[j]),b=Math.max(nodes[i],nodes[j]),key=a*output.points.length+b;if(seen.has(key))continue;seen.add(key);if(fill+48>buffer.length)flush();for(const n of [a,b])for(const value of output.points[n]){buffer.writeDoubleLE(value,fill);fill+=8;scalars++;}}
      flush();wires.push({key:`wire-${dimension}-${tag}`,scalars,chunks});
    };
    for(const [i,boundary]of boundaries.entries())wire(2,i+1,boundary.triangles,[[0,1],[1,2],[2,0]]);
    for(const cell of output.cells)wire(3,cell.cellIndex+1,cell.tetrahedra,[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]]);
  });
  projection.mesh.render.wires=wires;projection.mesh.render.storage={version:1,format:'float64-le',...proof};validateMeshRender(projection.mesh.render);if(file){const sealed=sealMeshRender(projection.mesh.render,file);if(JSON.stringify(sealed)!==JSON.stringify(proof))throw fault('MESH_ARTIFACT_INVALID','显示文件封存摘要不一致。');}return proof;
}
/** Writes only uncommitted, self-contained derived artifacts in an empty owned
 * directory. Publication belongs to the artifact pool AFTER exact worker exit.
 * Originals are never rewritten and blocked/diagnostic results emit no files. */
export function writeDiscreteMeshFiles({directory,snapshot,result,checkpoint,targetDocumentId,jobId,spatialLimits}){
  directory=emptyDirectory(directory);const {manifest,manifestProof}=buildDiscreteMeshFiles({snapshot,result,checkpoint,targetDocumentId,jobId,spatialLimits,write:(name,limit,action)=>writeFile(path.join(directory,name),limit,action),renderFile:path.join(directory,'render.bin')});return {manifest,manifestProof};
}
/** Recompute the exact expected bytes without writing or invoking a native
 * mesher. Stored acceptance flags or mutually altered manifests are not proof. */
export function expectedDiscreteMeshFiles(input){return buildDiscreteMeshFiles({...input,write:hashFileContents});}
function buildDiscreteMeshFiles({snapshot,result,checkpoint,targetDocumentId,jobId,spatialLimits,write,renderFile}){
  const projection=adaptDiscreteTetraMesh({snapshot,result,checkpoint,targetDocumentId,jobId,spatialLimits});
  if(!projection.normalMeshAdmitted)throw fault('MESH_DISCRETE_ADMISSION_REJECTED','离散网格未通过独立准入，未生成可用网格文件。',projection.mesh.admission);
  const msh=writeMsh(write,projection,result),render=writeRender(write,projection,result,renderFile);
  projection.mesh.exportMapping={version:1,format:'msh4.1-ascii',physicalGroups:msh.physicalGroups};
  const quality=write('quality.json',DISCRETE_MESH_FILE_LIMITS.quality,out=>{
    const {positions,cells,...header}=projection.index,begin=JSON.stringify(header);out.write(begin.slice(0,-1)+',"positions":[');
    for(let i=0;i<positions.length;i+=8192){if(i)out.write(',');out.write(positions.slice(i,i+8192).map(value=>JSON.stringify(value)).join(','));}out.write('],"cells":[');cells.forEach((cell,i)=>{if(i)out.write(',');out.write(JSON.stringify(cell));});out.write(']}');
  });
  const resultFile=write('result.json',DISCRETE_MESH_FILE_LIMITS.manifest,out=>out.write(JSON.stringify({ok:true,protocolVersion:1,requestId:jobId,mesh:projection.mesh})));
  const manifest={version:1,format:'web-cad-derived-discrete-mesh',jobId,basis:projection.basis,provenance:projection.provenance,defaultVisible:false,normalMeshAdmitted:true,rawResultNormalMeshAdmitted:false,source:projection.source,admission:projection.mesh.admission,files:{mesh:msh.proof,render,quality,result:resultFile}};
  const manifestProof=write('manifest.json',DISCRETE_MESH_FILE_LIMITS.manifest,out=>out.write(JSON.stringify(manifest)));
  return {manifest,manifestProof,projection};
}
