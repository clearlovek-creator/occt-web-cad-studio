import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hashFile,fileInventory,atomicJson,validateRelease,selectRelease,frontendEnvironment,productionServerPath,releaseProductionServerPath,copyCertifiedFiles,frontendBuildInputs} from '../gateway/frontend-release.mjs';
const workspace=path.resolve(import.meta.dirname,'..');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-frontend-release-')),id='frontend-'+Date.now()+'-'+randomUUID(),directory=path.join(root,id);fs.mkdirSync(directory);
  t.after(()=>{assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  for(const file of ['dist/server/index.js','dist/server/ssr/index.js','dist/client/assets/app-123.js','runtime/scripts/frontend-server.mjs','runtime/gateway/frontend-release.mjs','runtime/gateway/frontend-proxy.mjs','runtime/gateway/frontend-assets.mjs']){const target=path.join(directory,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'export default {};');}
  const manifest={format:'web-cad-frontend-release',version:1,releaseId:id,builtAt:new Date().toISOString(),runtime:'vinext-node',apiMode:'same-origin',sourceSha256:'1'.repeat(64),dependencyLockSha256:hashFile(path.join(workspace,'package-lock.json')),productionServerSha256:hashFile(productionServerPath(workspace)),files:fileInventory(directory)};
  atomicJson(path.join(directory,'release.json'),manifest);atomicJson(path.join(root,'selected.json'),{format:'web-cad-frontend-selection',version:1,releaseId:id});
  return {root,id,directory,manifest};
}

test('release selection certifies all client, server and pinned runtime bytes before launch',t=>{
  const f=fixture(t),release=selectRelease(f.root,workspace);assert.equal(release.releaseId,f.id);assert.equal(release.apiMode,'same-origin');assert.equal(release.files.length,7);assert.equal(selectRelease(f.root,workspace,f.id).directory,f.directory);
});
test('missing release, corrupt selection and path traversal fail closed without creating a development fallback',t=>{
  const f=fixture(t);assert.throws(()=>selectRelease(path.join(f.root,'missing'),workspace),e=>e.code==='FRONTEND_RELEASE_MISSING');
  for(const releaseId of ['../outside','frontend-invalid',f.id+'/..'])assert.throws(()=>selectRelease(f.root,workspace,releaseId),e=>e.code==='FRONTEND_RELEASE_INVALID');
  fs.writeFileSync(path.join(f.root,'selected.json'),'broken');assert.throws(()=>selectRelease(f.root,workspace),e=>e.code==='FRONTEND_RELEASE_INVALID');
});
test('tampered, extra or missing resources and incompatible installed runtime block the selected release',t=>{
  const f=fixture(t),target=path.join(f.directory,'dist/client/assets/app-123.js'),bytes=fs.readFileSync(target);
  fs.writeFileSync(target,'tamper');assert.throws(()=>validateRelease(f.directory,workspace),/校验不一致/);fs.writeFileSync(target,bytes);
  fs.writeFileSync(path.join(f.directory,'extra.js'),'unexpected');assert.throws(()=>validateRelease(f.directory,workspace),/校验不一致/);fs.rmSync(path.join(f.directory,'extra.js'));
  fs.rmSync(target);assert.throws(()=>validateRelease(f.directory,workspace),/校验不一致/);fs.writeFileSync(target,bytes);
  for(const field of ['dependencyLockSha256','productionServerSha256']){atomicJson(path.join(f.directory,'release.json'),{...f.manifest,[field]:'0'.repeat(64)});assert.throws(()=>validateRelease(f.directory,workspace),/不一致/);}
});
test('symbolic links, hard-linked resources and oversized manifest are never accepted as release evidence',t=>{
  const f=fixture(t),target=path.join(f.directory,'dist/client/assets/app-123.js');fs.linkSync(target,path.join(f.root,'hard-link'));
  assert.throws(()=>validateRelease(f.directory,workspace),/类型无效/);fs.rmSync(path.join(f.root,'hard-link'));
  const link=path.join(f.directory,'linked');fs.symlinkSync(path.join(f.directory,'dist'),link,process.platform==='win32'?'junction':'dir');assert.throws(()=>validateRelease(f.directory,workspace),/符号链接/);fs.unlinkSync(link);
  fs.writeFileSync(path.join(f.directory,'release.json'),' '.repeat(2*1024*1024+1));assert.throws(()=>validateRelease(f.directory,workspace),/大小无效/);
});
test('atomic selection failure preserves the prior selected release and removes only its own temporary file',t=>{
  const f=fixture(t),file=path.join(f.root,'selected.json'),before=fs.readFileSync(file),rename=fs.renameSync;
  fs.renameSync=()=>{throw Error('injected rename failure');};try{assert.throws(()=>atomicJson(file,{new:true}),/injected/);}finally{fs.renameSync=rename;}
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.readdirSync(f.root).filter(name=>name.endsWith('.tmp')).length,0);
});
test('frontend process environment excludes provider credentials and unrelated public variables',()=>{
  const env={Path:'system-path',SystemRoot:'windows',TEMP:'tmp',NODE_ENV:'production',NEXT_PUBLIC_GEOMETRY_API_URL:'http://127.0.0.1:8788/api',AGENT_CONFIG_SECRET:'secret',OPENAI_API_KEY:'secret',DEEPSEEK_API_KEY:'secret',NEXT_PUBLIC_PRIVATE_TOKEN:'secret',CAD_DOCUMENT_ID:'private'};
  const selected=frontendEnvironment(env);assert.equal(selected.Path,'system-path');assert.equal(selected.NODE_ENV,'production');assert.ok(!JSON.stringify(selected).includes('secret'));assert.equal(selected.CAD_DOCUMENT_ID,undefined);
});

test('certified file copies preserve every byte under a Chinese Windows destination',t=>{
  const f=fixture(t),target=path.join(f.root,'发布-源码快照'),files=fileInventory(path.join(f.directory,'dist'));
  copyCertifiedFiles(path.join(f.directory,'dist'),target,files);assert.deepEqual(fileInventory(target),files);
  assert.throws(()=>copyCertifiedFiles(path.join(f.directory,'dist'),path.join(f.root,'invalid'),[{file:'../outside',bytes:1,sha256:'0'.repeat(64)}]),/无效相对路径/);
});

function standaloneFixture(t){
  const f=fixture(t),vendor=path.join(f.directory,'runtime/vendor/vinext');fs.mkdirSync(path.join(vendor,'dist/server'),{recursive:true});
  fs.writeFileSync(path.join(vendor,'package.json'),JSON.stringify({name:'vinext',version:'test-1',type:'module',license:'MIT'}));fs.writeFileSync(path.join(vendor,'LICENSE'),'MIT fixture license');fs.writeFileSync(path.join(vendor,'dist/server/prod-server.js'),'export const startProdServer=()=>{};');
  fs.mkdirSync(path.join(f.directory,'runtime/provenance'));const lock=path.join(f.directory,'runtime/provenance/package-lock.json');fs.writeFileSync(lock,'{"name":"fixture"}');
  f.manifest={...f.manifest,version:2,nodeVersion:process.versions.node,dependencyLockSha256:hashFile(lock),productionServerSha256:hashFile(path.join(vendor,'dist/server/prod-server.js')),productionRuntime:{version:1,packageName:'vinext',packageVersion:'test-1',license:'MIT',entry:'dist/server/prod-server.js',files:fileInventory(vendor),dynamicEntries:[]},files:fileInventory(f.directory,{exclude:['release.json']})};
  atomicJson(path.join(f.directory,'release.json'),f.manifest);return {...f,vendor,lock};
}

test('standalone V2 selects its own production runner without any host lockfile or host dependencies',t=>{
  const f=standaloneFixture(t),host=path.join(f.root,'empty host');fs.mkdirSync(host);
  const release=selectRelease(f.root,host);assert.equal(release.version,2);assert.equal(releaseProductionServerPath(release,host),path.join(f.vendor,'dist/server/prod-server.js'));assert.equal(validateRelease(f.directory).releaseId,f.id);assert.deepEqual(fs.readdirSync(host),[]);
  assert.equal(releaseProductionServerPath({version:1},workspace),productionServerPath(workspace));assert.deepEqual(frontendBuildInputs(2).slice(-2),['scripts/build-frontend-release.mjs','scripts/frontend-runtime-closure.mjs']);assert.equal(frontendBuildInputs(1).includes('scripts/frontend-runtime-closure.mjs'),false);
});

test('standalone V2 refuses missing, extra or changed runner files and cannot fall back to installed runner',t=>{
  const f=standaloneFixture(t),entry=path.join(f.vendor,'dist/server/prod-server.js'),before=fs.readFileSync(entry);
  fs.writeFileSync(entry,'changed');assert.throws(()=>validateRelease(f.directory,workspace),/随包生产运行器/);fs.writeFileSync(entry,before);
  fs.writeFileSync(path.join(f.vendor,'extra.js'),'export {};');assert.throws(()=>validateRelease(f.directory,workspace),/随包生产运行器/);fs.rmSync(path.join(f.vendor,'extra.js'));
  fs.rmSync(entry);assert.throws(()=>validateRelease(f.directory,workspace),/随包生产运行器/);fs.writeFileSync(entry,before);assert.equal(validateRelease(f.directory,workspace).version,2);
});

test('standalone V2 freezes lock provenance and exact Node version without consulting the development tree',t=>{
  const f=standaloneFixture(t),before=fs.readFileSync(f.lock);fs.writeFileSync(f.lock,'{}');assert.throws(()=>validateRelease(f.directory,workspace),/随包依赖锁/);fs.writeFileSync(f.lock,before);
  for(const patch of [{nodeVersion:'0.0.0'},{productionServerSha256:'0'.repeat(64)},{dependencyLockSha256:'0'.repeat(64)}]){atomicJson(path.join(f.directory,'release.json'),{...f.manifest,...patch});assert.throws(()=>validateRelease(f.directory,workspace),/不一致/);}
});

test('standalone V2 rejects invalid runner metadata, budgets and unaudited dynamic entry claims',t=>{
  const f=standaloneFixture(t),valid=f.manifest.productionRuntime;
  for(const patch of [{packageName:'other'},{packageVersion:''},{license:'other'},{entry:'../other.js'},{files:null},{files:[...valid.files,{file:'../escape',bytes:1,sha256:'0'.repeat(64)}]},{files:valid.files.map((file,index)=>index?file:{...file,bytes:-1})},{files:valid.files.map((file,index)=>index?file:{...file,bytes:1024*1024+1})},{dynamicEntries:[{file:valid.entry,scope:'certified-build-entry',expression:'arbitrary'}]},{dynamicEntries:[{file:'other.js',scope:'certified-build-entry',expression:'`${pathToFileURL(rscEntryPath).href}?t=${rscMtime}`'}]}]){
    atomicJson(path.join(f.directory,'release.json'),{...f.manifest,productionRuntime:{...valid,...patch}});assert.throws(()=>validateRelease(f.directory,workspace),/随包生产运行器/);
  }
  const dynamic={file:valid.entry,scope:'certified-build-entry',expression:'`${pathToFileURL(rscEntryPath).href}?t=${rscMtime}`'};
  atomicJson(path.join(f.directory,'release.json'),{...f.manifest,productionRuntime:{...valid,dynamicEntries:[dynamic,dynamic]}});assert.throws(()=>validateRelease(f.directory),/动态入口/);
  atomicJson(path.join(f.directory,'release.json'),{...f.manifest,productionRuntime:{...valid,dynamicEntries:[dynamic]}});assert.equal(validateRelease(f.directory).version,2);
});

test('V1 compatibility is explicit: a copied legacy release still requires its original host dependencies',t=>{
  const f=fixture(t),host=path.join(f.root,'empty legacy host');fs.mkdirSync(host);assert.throws(()=>validateRelease(f.directory,host),/package-lock.json/);assert.equal(selectRelease(f.root,workspace).version,1);
});
