import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {workbenchFileInventory} from '../gateway/workbench-bundle.mjs';
import {fileInventory} from '../gateway/frontend-release.mjs';

const MiB=1024*1024;
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-workbench-inventory-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-workbench-inventory-/);fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,'Start-WebCAD.ps1'),'start');
  for(const folder of ['app','backend','frontend','node']){fs.mkdirSync(path.join(root,folder));fs.writeFileSync(path.join(root,folder,'entry'),'x');}
  return root;
}
// Exercise byte accounting without allocating GiB-sized test files. Hashing and
// all path/type checks remain real; only these fixture files' stat sizes vary.
function withSizes(sizes,run){
  const original=fs.lstatSync;
  fs.lstatSync=function(file,...args){const stat=original.call(this,file,...args),size=sizes.get(path.resolve(file));if(size!==undefined)stat.size=size;return stat;};
  try{return run();}finally{fs.lstatSync=original;}
}

test('workbench composition matches ordinary inventory ordering and excludes only its own manifest',t=>{
  const root=fixture(t);fs.writeFileSync(path.join(root,'workbench.json'),'{}');
  assert.deepEqual(workbenchFileInventory(root),fileInventory(root));
  assert.deepEqual(workbenchFileInventory(root,{excludeManifest:true}),fileInventory(root,{exclude:['workbench.json']}));
});
test('a composition larger than 512 MiB does not enlarge the individual component budget',t=>{
  const root=fixture(t),sizes=new Map(['app','backend'].map(folder=>[path.join(root,folder,'entry'),300*MiB]));
  withSizes(sizes,()=>{assert.throws(()=>fileInventory(root),/512 MiB/);assert.equal(workbenchFileInventory(root).reduce((sum,row)=>sum+row.bytes,0),600*MiB+7);});
  sizes.set(path.join(root,'backend','entry'),512*MiB+1);
  withSizes(sizes,()=>assert.throws(()=>workbenchFileInventory(root),/512 MiB/));
});
test('aggregate composition remains bounded even when every component is individually within budget',t=>{
  const root=fixture(t),sizes=new Map(['app','backend','frontend','node'].map(folder=>[path.join(root,folder,'entry'),256*MiB]));
  withSizes(sizes,()=>assert.throws(()=>workbenchFileInventory(root),/1 GiB or 10000/));
  sizes.set(path.join(root,'node','entry'),256*MiB-5);
  withSizes(sizes,()=>assert.equal(workbenchFileInventory(root).reduce((sum,row)=>sum+row.bytes,0),1024*MiB));
});
test('omitting the manifest from the self-inventory never exempts its bytes from the aggregate budget',t=>{
  const root=fixture(t),sizes=new Map(['app','backend','frontend','node'].map(folder=>[path.join(root,folder,'entry'),256*MiB]));sizes.set(path.join(root,'node','entry'),256*MiB-5);
  fs.writeFileSync(path.join(root,'workbench.json'),'{}');
  withSizes(sizes,()=>assert.throws(()=>workbenchFileInventory(root,{excludeManifest:true}),/1 GiB or 10000/));
});
test('composition rejects unexpected root files, directories, wrong component types and missing entries',t=>{
  const root=fixture(t),extra=path.join(root,'unexpected');fs.writeFileSync(extra,'x');assert.throws(()=>workbenchFileInventory(root),/unexpected/);fs.unlinkSync(extra);
  fs.mkdirSync(extra);assert.throws(()=>workbenchFileInventory(root),/unexpected/);fs.rmdirSync(extra);
  const component=path.join(root,'node');fs.renameSync(component,path.join(root,'saved-node'));fs.writeFileSync(component,'not a directory');assert.throws(()=>workbenchFileInventory(root),/ordinary directories/);fs.unlinkSync(component);fs.renameSync(path.join(root,'saved-node'),component);
  fs.unlinkSync(path.join(root,'Start-WebCAD.ps1'));assert.throws(()=>workbenchFileInventory(root),/missing/);
});
test('composition refuses linked roots, shared files and oversized root metadata even when excluded',t=>{
  const root=fixture(t),component=path.join(root,'node'),saved=path.join(root,'saved-node');fs.renameSync(component,saved);fs.symlinkSync(saved,component,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>workbenchFileInventory(root),/ordinary directories/);fs.unlinkSync(component);fs.renameSync(saved,component);
  const shared=path.join(root,'app','shared');fs.linkSync(path.join(root,'app','entry'),shared);assert.throws(()=>workbenchFileInventory(root),/类型无效/);fs.unlinkSync(shared);
  const manifest=path.join(root,'workbench.json');fs.writeFileSync(manifest,'{}');
  withSizes(new Map([[manifest,2*MiB+1]]),()=>assert.throws(()=>workbenchFileInventory(root,{excludeManifest:true}),/invalid entry/));
});
test('combined file count cannot bypass the unchanged 10000-file cap by spreading across components',t=>{
  const root=fixture(t),original=fs.readdirSync;
  fs.readdirSync=function(folder,...args){const entries=original.call(this,folder,...args);return path.dirname(path.resolve(folder))===root&&args[0]?.withFileTypes?Array.from({length:2500},()=>entries[0]):entries;};
  try{assert.throws(()=>workbenchFileInventory(root),/1 GiB or 10000/);}finally{fs.readdirSync=original;}
});
