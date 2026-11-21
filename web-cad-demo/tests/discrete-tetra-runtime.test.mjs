import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configureDiscreteTetraRuntime} from '../gateway/discrete-tetra-runtime.mjs';
import {fileInventory} from '../gateway/frontend-release.mjs';
test('discrete tetra task runtime never falls back from a legacy backend or workspace PATH',()=>{
  for(const options of [{},{mode:'workspace-source'},{mode:'project-code-snapshot',surfaceRuntime:{factory(){throw Error('must not run');}}}])assert.equal(configureDiscreteTetraRuntime({...options,environment:{PATH:'C:/unverified',MESH_WORKER_PATH:'C:/old.exe'}}).factory,null);
});
test('sealed mesh task runtime clones its declaration and verifies exact files before creating either client',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-tetra-runtime-')),workerPath=path.join(root,'mesh.exe');fs.writeFileSync(workerPath,'sealed-fixture');t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-tetra-runtime-/);fs.rmSync(root,{recursive:true,force:true});});
  const sealedMesh={workerPath,runtimePath:root,files:fileInventory(root)},made=[];class Client{constructor(options){made.push(options);this.children=new Set();}closeAndWait(){return Promise.resolve();}}
  const runtime=configureDiscreteTetraRuntime({mode:'project-code-snapshot',sealedMesh,surfaceRuntime:{factory:()=>({children:new Set(),closeAndWait:async()=>{}})},environment:{MESH_WORKER_PATH:'C:/wrong.exe'},Client});sealedMesh.files[0].sha256='f'.repeat(64);runtime.factory();assert.equal(made[0].workerPath,workerPath);fs.appendFileSync(workerPath,'changed');assert.throws(()=>runtime.factory(),{code:'MESH_DISCRETE_RUNTIME_INVALID'});assert.equal(made.length,1);
});
