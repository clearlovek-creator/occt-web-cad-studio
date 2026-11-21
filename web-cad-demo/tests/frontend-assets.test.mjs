import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileInventory} from '../gateway/frontend-release.mjs';
import {createAssetHandler} from '../gateway/frontend-assets.mjs';
async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-client-assets-'));
  for(const [file,content] of [['assets/app-test.js','export const value = 42;'],['assets/style.css','body {color:blue}'],['assets/_vinext_fonts/font.woff2','font'],['.vite/manifest.json','private'],['_headers','private'],['favicon.svg','<svg/>']]){const target=path.join(directory,'dist/client',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);}
  let fallthrough=0;
  const files=fileInventory(directory),handler=createAssetHandler({directory,files}),server=http.createServer((request,response)=>{if(!handler(request,response)){fallthrough++;response.writeHead(404);response.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.ok(directory.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});});
  return {url:'http://127.0.0.1:'+server.address().port,directory,files,handler,fallthrough:()=>fallthrough};
}
test('certified Windows client assets serve valid MIME, exact bytes, strong cache identity and HEAD/304',async t=>{
  const f=await fixture(t),response=await fetch(f.url+'/assets/app-test.js');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/javascript/);assert.equal(await response.text(),'export const value = 42;');const etag=response.headers.get('etag');assert.equal(etag,'"'+f.files.find(item=>item.file.endsWith('app-test.js')).sha256+'"');
  const head=await fetch(f.url+'/assets/app-test.js',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.ok(Number(head.headers.get('content-length'))>0);
  const cached=await fetch(f.url+'/assets/app-test.js',{headers:{'If-None-Match':etag}});assert.equal(cached.status,304);assert.equal(await cached.text(),'');assert.equal((await fetch(f.url+'/assets/_vinext_fonts/font.woff2')).status,200);
});
test('private metadata, encoded path separators and unknown files are not exposed as public assets',async t=>{
  const f=await fixture(t);for(const route of ['/.vite/manifest.json','/_headers','/assets%2fapp-test.js','/runtime/scripts/frontend-server.mjs','/assets/unknown.js'])assert.equal((await fetch(f.url+route)).status,404,route);
  assert.equal(f.fallthrough(),0,'Private and unknown asset paths cannot reach the framework static fallback');
  assert.equal((await fetch(f.url+'/application-route')).status,404);assert.equal(f.fallthrough(),1,'Ordinary application routes still belong to the framework');
  const write=await fetch(f.url+'/assets/app-test.js',{method:'POST',body:'not an asset edit'});assert.equal(write.status,405);assert.equal(write.headers.get('allow'),'GET, HEAD');
});
test('changed or missing live resources never inherit the certified ETag or a cached success',async t=>{
  const f=await fixture(t),before=await fetch(f.url+'/assets/app-test.js'),etag=before.headers.get('etag'),file=path.join(f.directory,'dist/client/assets/app-test.js');assert.equal(f.handler.healthy(),true);fs.appendFileSync(file,' changed');assert.equal(f.handler.healthy(),false);
  const changed=await fetch(f.url+'/assets/app-test.js',{headers:{'If-None-Match':etag}});assert.equal(changed.status,503);assert.equal((await changed.json()).code,'FRONTEND_ASSET_CHANGED');assert.equal(changed.headers.get('cache-control'),'no-store');
  fs.rmSync(file);assert.equal((await fetch(f.url+'/assets/app-test.js')).status,503);
});

test('same-size live replacement and restoring bytes still require a new validated asset handler',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'dist/client/assets/app-test.js'),original=fs.readFileSync(file),changed=Buffer.from(original);changed[0]^=1;
  fs.writeFileSync(file,changed);assert.equal(f.handler.healthy(),false);assert.equal((await fetch(f.url+'/assets/app-test.js')).status,503);
  fs.writeFileSync(file,original);assert.equal(f.handler.healthy(),false);assert.equal((await fetch(f.url+'/assets/app-test.js')).status,503);
  assert.equal(createAssetHandler({directory:f.directory,files:f.files}).healthy(),true);
});

test('actual certified bytes are checked even when every observed timestamp and identity field collides',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'dist/client/assets/app-test.js'),original=fs.readFileSync(file),identity=fs.lstatSync(file,{bigint:true}),changed=Buffer.from(original);changed[0]^=1;
  const lstat=fs.lstatSync,fstat=fs.fstatSync;
  fs.writeFileSync(file,changed);
  try{
    fs.lstatSync=(target,...args)=>String(target)===file?identity:lstat(target,...args);
    fs.fstatSync=(fd,...args)=>{const actual=fstat(fd,...args);return actual.ino===identity.ino?identity:actual;};
    assert.equal(f.handler.healthy(),false,'Metadata equality must not certify different content');
  }finally{fs.lstatSync=lstat;fs.fstatSync=fstat;}
  fs.writeFileSync(file,original);assert.equal(f.handler.healthy(),false,'Once observed invalid, restoring bytes cannot revive the old instance');
  assert.equal(createAssetHandler({directory:f.directory,files:f.files}).healthy(),true);
});

test('a path change after verification cannot alter the bytes sent under a certified ETag',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'dist/client/assets/app-test.js'),original=fs.readFileSync(file),chunks=[],headers={};
  const request={url:'/assets/app-test.js',method:'GET',headers:{}},response={writeHead(status,value){assert.equal(status,200);Object.assign(headers,value);fs.writeFileSync(file,Buffer.alloc(original.length,88));},end(value){chunks.push(value);}};
  assert.equal(f.handler(request,response),true);assert.deepEqual(Buffer.concat(chunks),original);assert.equal(headers.ETag,'"'+f.files.find(item=>item.file.endsWith('app-test.js')).sha256+'"');assert.equal(f.handler.healthy(),false);
});
