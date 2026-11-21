import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectProductionRuntime,copyProductionRuntime} from '../scripts/frontend-runtime-closure.mjs';
import {fileInventory} from '../gateway/frontend-release.mjs';

function fixture(t,source='export const startProdServer=()=>{};'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-runner-closure-')),pkg=path.join(root,'node_modules/vinext');
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const write=(name,value)=>{const file=path.join(pkg,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
  write('package.json',JSON.stringify({name:'vinext',version:'test-1',type:'module',license:'MIT'}));write('LICENSE','MIT fixture license');write('dist/server/prod-server.js',source);
  return {root,pkg,write};
}

test('runner closure follows static imports, reexports, literal dynamic imports and cycles but ignores comments',t=>{
  const f=fixture(t,'import fs from "node:fs";import "./a.js";export * from "./b.js";await import("./c.mjs"); /* import "not-real" */');
  f.write('dist/server/a.js','import "./prod-server.js";');f.write('dist/server/b.js','export {};');f.write('dist/server/c.mjs','import "path";');f.write('unused.js','throw Error("must not execute");');
  const result=collectProductionRuntime(f.pkg);assert.deepEqual(result.files.map(file=>file.file),['LICENSE','dist/server/a.js','dist/server/b.js','dist/server/c.mjs','dist/server/prod-server.js','package.json']);assert.deepEqual(result.dynamicEntries,[]);
});

test('runner closure records only explicitly reviewed build-entry expressions',t=>{
  const first='`${pathToFileURL(rscEntryPath).href}?t=${rscMtime}`',second='`${pathToFileURL(serverEntryPath).href}?t=${serverMtime}`';
  const f=fixture(t,`await import(${second});await import(${first});`),result=collectProductionRuntime(f.pkg);
  assert.deepEqual(result.dynamicEntries,[first,second].map(expression=>({file:'dist/server/prod-server.js',expression,scope:'certified-build-entry'})));
  f.write('dist/server/a.js',`await import(${first});`);f.write('dist/server/prod-server.js','import "./a.js";');assert.throws(()=>collectProductionRuntime(f.pkg),/Unreviewed computed/);
});

test('runner closure refuses bare packages, escaping paths, missing inputs and unsupported module formats',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'outside.js'),'export {};');
  for(const source of ['import "react";','import "../../../outside.js";','import "./missing.js";','import "./data.json";']){
    f.write('dist/server/data.json','{}');f.write('dist/server/prod-server.js',source);assert.throws(()=>collectProductionRuntime(f.pkg));
  }
});

test('runner closure refuses unreviewed loaders and malformed modules without executing top-level code',t=>{
  const f=fixture(t);
  for(const source of ['await import(variable);','await import();','require("fs");','eval("x");','createRequire(import.meta.url);','import {']){f.write('dist/server/prod-server.js',source);assert.throws(()=>collectProductionRuntime(f.pkg));}
  f.write('dist/server/prod-server.js','throw Error("module must not execute during collection");');assert.equal(collectProductionRuntime(f.pkg).files.length,3);
});

test('runner closure requires exact package identity, module scope and retained license',t=>{
  const f=fixture(t),valid={name:'vinext',version:'test-1',type:'module',license:'MIT'};
  for(const patch of [{name:'other'},{version:''},{version:'x'.repeat(81)},{type:'commonjs'},{license:'unknown'}]){f.write('package.json',JSON.stringify({...valid,...patch}));assert.throws(()=>collectProductionRuntime(f.pkg),/identity or license/);}
  f.write('package.json',JSON.stringify(valid));f.write('LICENSE','');assert.throws(()=>collectProductionRuntime(f.pkg),/license/);fs.rmSync(path.join(f.pkg,'LICENSE'));assert.throws(()=>collectProductionRuntime(f.pkg));
});

test('runner closure rejects linked package inputs rather than certifying shared mutable files',t=>{
  const f=fixture(t),entry=path.join(f.pkg,'dist/server/prod-server.js'),hard=path.join(f.root,'hard.js');
  fs.linkSync(entry,hard);assert.throws(()=>collectProductionRuntime(f.pkg),/ordinary file/);fs.rmSync(hard);
  fs.renameSync(path.join(f.pkg,'dist/server'),path.join(f.pkg,'dist/real-server'));fs.symlinkSync(path.join(f.pkg,'dist/real-server'),path.join(f.pkg,'dist/server'),process.platform==='win32'?'junction':'dir');assert.throws(()=>collectProductionRuntime(f.pkg),/目录类型无效/);
});

test('runner closure has per-file, total-byte and module-count limits',t=>{
  const f=fixture(t);f.write('dist/server/prod-server.js',' '.repeat(1024*1024+1));assert.throws(()=>collectProductionRuntime(f.pkg),/bounded ordinary file/);
  f.write('dist/server/prod-server.js','import "./part-0.js";');
  for(let index=0;index<9;index++)f.write(`dist/server/part-${index}.js`,(index<8?`import "./part-${index+1}.js";`:'')+' '.repeat(1000000));
  assert.throws(()=>collectProductionRuntime(f.pkg),/8 MiB/);
  for(let index=0;index<255;index++)f.write(`dist/server/part-${index}.js`,index<254?`import "./part-${index+1}.js";`:'export {};');
  assert.throws(()=>collectProductionRuntime(f.pkg),/256 files/);
});

test('copied runner closure is byte-identical and includes licenses but no compiler or unused source',t=>{
  const f=fixture(t),output=path.join(f.root,'发布 运行目录'),proof=copyProductionRuntime(f.root,output);
  assert.deepEqual(fileInventory(path.join(output,'runtime/vendor/vinext')),proof.files);assert.equal(fs.existsSync(path.join(output,'node_modules/typescript')),false);
});

test('installed production runner import closure is fully collected with two reviewed generated entry loads',()=>{
  const proof=collectProductionRuntime(path.resolve(import.meta.dirname,'../node_modules/vinext'));
  assert.equal(proof.packageVersion,'0.0.50');assert.equal(proof.files.length,44);assert.equal(proof.dynamicEntries.length,2);assert.ok(proof.files.some(file=>file.file==='LICENSE'));assert.ok(proof.files.some(file=>file.file===proof.entry));
});
