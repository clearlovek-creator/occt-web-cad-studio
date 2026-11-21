/* Real compatibility fixture, not an import API bypass or product test flag. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {decodeProjectPackage,encodeProjectPackage,PROJECT_MIME} from '../../gateway/project-package.mjs';
export async function openLegacyStepProject(api,sourceDocumentId,targetDocumentId){
  const endpoint=new URL(api);assert.equal(endpoint.hostname,'127.0.0.1');assert.notEqual(endpoint.port,'8788','Never rewrite a daily project to construct a test fixture');assert.ok(sourceDocumentId.endsWith('_modern'));for(const id of [sourceDocumentId,targetDocumentId])assert.match(id,/^[A-Za-z0-9_-]+$/);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-legacy-step-')),snapshot=path.join(directory,'legacy.xbf');let verified=false;
  try{
    const saved=await fetch(`${api}/documents/${sourceDocumentId}/project/save`,{method:'POST'});assert.equal(saved.status,200);const project=decodeProjectPackage(Buffer.from(await saved.arrayBuffer()));fs.writeFileSync(snapshot,project.geometry,{flag:'wx'});
    const worker=process.env.GEOMETRY_WORKER_PATH;assert.ok(worker,'Use the registered native test pair');const env={...process.env},inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=[path.resolve(import.meta.dirname,'../../../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
    const result=spawnSync(path.join(path.dirname(worker),'step_import_tests.exe'),['--legacy-naming-snapshot',snapshot],{env,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(result.status,0,[result.error?.message,result.stderr,result.stdout].filter(Boolean).join('\n'));assert.match(result.stdout,/PASS legacy STEP naming snapshot fixture/);
    const response=await fetch(`${api}/documents/${targetDocumentId}/project/open`,{method:'POST',headers:{'content-type':PROJECT_MIME},body:encodeProjectPackage({...project,geometry:fs.readFileSync(snapshot)})}),opened=await response.json();assert.equal(response.status,200,JSON.stringify(opened));assert.equal(opened.ok,true);assert.equal(opened.features[0].numberParameters.importNamingVersion,undefined);
    for(const body of opened.bodyMetadata){assert.equal(body.topologyNaming.namedFaceCount,0);assert.equal(body.topologyNaming.namedEdgeCount,0);}
    const summaryResponse=await fetch(api+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:targetDocumentId,operation:'document.summary'})}),summary=await summaryResponse.json();assert.equal(summaryResponse.status,200);assert.equal(summary.ok,true);assert.equal(typeof summary.activeBodyId,'string');
    verified=true;return summary;
  }finally{if(verified){assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cad-legacy-step-'));fs.rmSync(directory,{recursive:true,force:true});}else console.error('Preserved legacy STEP fixture: '+directory);}
}
