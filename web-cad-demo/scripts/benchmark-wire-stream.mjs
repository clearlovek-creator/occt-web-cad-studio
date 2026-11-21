/* Isolated client binary-read/crypto/local-buffer pressure, not CAD meshing or
 * GPU throughput. No network, provider calls, or user project access. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {importTestTypeScript} from '../tests/helpers/import-typescript.mjs';
const root=path.resolve(import.meta.dirname,'..'),reference=path.join(root,'.artifacts/wire-stream-reference/mesh-wire-read.ts'),current=path.join(root,'app/model/mesh-wire-read.ts');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(process.argv[2]==='--child'){
  const [mode,partValue,countValue]=process.argv.slice(3),partBytes=Number(partValue),concurrency=Number(countValue),size=1048560;
  assert.ok(['reference','current'].includes(mode)&&[1,1024,65536].includes(partBytes)&&[1,4].includes(concurrency));
  const {readMeshWireChunk}=await importTestTypeScript(pathToFileURL(mode==='reference'?reference:current).href,import.meta.url);
  const payloads=Array.from({length:concurrency},()=>{const bytes=Buffer.alloc(size);for(let i=0;i<size/8;i++)bytes.writeDoubleLE(1e9+(i%6<3?0:1),i*8);return bytes;}),digests=payloads.map(bytes=>crypto.createHash('sha256').update(bytes).digest('hex'));
  let readBytes=0,reads=0,cancels=0,releases=0,ticks=0,readingTicks=0,maxGapMs=0,last=performance.now();
  const interval=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;ticks++;if(readBytes<size*concurrency)readingTicks++;},5),started=performance.now();
  let results;
  try{results=await Promise.all(payloads.map((payload,index)=>{let offset=0;const reader={read:async()=>{reads++;if(offset===size)return {done:true};const value=payload.subarray(offset,Math.min(size,offset+partBytes));offset+=value.length;readBytes+=value.length;return {done:false,value};},cancel:async()=>{cancels++;},releaseLock:()=>{releases++;}};return readMeshWireChunk({apiRoot:'/unused',jobId:'benchmark',wireKey:`wire-3-${index+1}`,index:0,chunk:{offset:0,bytes:size,sha256:digests[index]},signal:new AbortController().signal,fetcher:async()=>({ok:true,headers:new Headers({'X-CAD-Mesh-Format':'float64-le','X-CAD-Mesh-Wire':`wire-3-${index+1}`,'X-CAD-Mesh-Chunk':'0','Content-Length':String(size)}),body:{getReader:()=>reader}})});}));}
  finally{maxGapMs=Math.max(maxGapMs,performance.now()-last);clearInterval(interval);}
  const elapsedMs=performance.now()-started;
  for(const result of results){assert.deepEqual(result.origin,[1e9,1e9,1e9]);assert.equal(result.positions.length,size/8);for(let i=0;i<result.positions.length;i++)assert.equal(result.positions[i],i%6<3?0:1);}
  assert.equal(cancels,0);assert.equal(releases,concurrency);assert.equal(readBytes,size*concurrency);if(mode==='current'&&partBytes===1)assert.ok(readingTicks>0);
  const outputSha256=results.map(result=>crypto.createHash('sha256').update(Buffer.from(result.positions.buffer,result.positions.byteOffset,result.positions.byteLength)).digest('hex'));
  console.log(JSON.stringify({mode,chunkBytes:size,partBytes,concurrency,elapsedMs,maxGapMs,ticks,readingTicks,reads,outputSha256,maxRssKiB:process.resourceUsage().maxRSS}));
}else{
  const sources=()=>Object.fromEntries(['app/model/mesh-wire-read.ts','app/model/viewport-coordinates.ts','tests/helpers/import-typescript.mjs','scripts/benchmark-wire-stream.mjs','.artifacts/wire-stream-reference/mesh-wire-read.ts','.artifacts/wire-stream-reference/viewport-coordinates.ts'].map(file=>[file,hash(path.join(root,file))])),before=sources(),samples=[];
  for(const [partBytes,concurrency] of [[65536,1],[1024,1],[1,1],[65536,4],[1024,4]])for(const mode of ['reference','current'])for(let sample=0;sample<3;sample++){
    const child=spawn(process.execPath,['--max-old-space-size=512',import.meta.filename,'--child',mode,String(partBytes),String(concurrency)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',diagnostic='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>diagnostic=(diagnostic+bytes).slice(-8192));
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,diagnostic);samples.push({...JSON.parse(output.trim()),sample});
  }
  for(const [partBytes,concurrency] of [[65536,1],[1024,1],[1,1],[65536,4],[1024,4]]){const matching=samples.filter(row=>row.partBytes===partBytes&&row.concurrency===concurrency);for(const row of matching)assert.deepEqual(row.outputSha256,matching[0].outputSha256);}
  assert.deepEqual(sources(),before);
  const report={format:'web-cad-wire-stream-pressure',version:1,scope:'isolated binary read/SHA-256/local float32 conversion; synthetic line data, no native meshing or GPU; separate child per sample, 512 MiB old-space limit, maxRSS excludes other processes',limits:'one 1048560-byte chunk per reader; default 15s read deadline',environment:{node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length},caveats:['OS cache not evicted','reference runs first','CPU not exclusive','maxRSS is per child, not entire CAD/browser/GPU'],sources:before,samples};const file=path.join(root,'.artifacts/performance/wire-stream.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,samples:samples.length,report:file}));
}
