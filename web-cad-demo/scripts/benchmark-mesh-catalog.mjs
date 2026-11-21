/* Metadata recovery benchmark, not CAD meshing, GPU or industrial corpus QA. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {MeshJobStore} from '../gateway/mesh-job-store.mjs';
import {MeshArtifactPool} from '../gateway/mesh-artifact-pool.mjs';
const root=path.resolve(import.meta.dirname,'..'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
if(process.argv[2]==='--child'){
  const mode=process.argv[3],data=path.resolve(process.argv[4]);assert.ok(['reference','threaded'].includes(mode));assert.ok(data.startsWith(path.join(root,'.artifacts')+path.sep));
  let previous=performance.now(),maxGap=0,ticks=0;
  const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;ticks++;},5);
  await pause(30);maxGap=0;ticks=0;previous=performance.now();const start=performance.now();let result,pool;
  try{
    result=mode==='reference'?new MeshJobStore(data).loadCatalog():await (pool=new MeshArtifactPool({dataDir:data})).execute({operation:'recover-catalog'});
    const elapsedMs=performance.now()-start;await pause(20);clearInterval(timer);await pool?.close();
    const jobs=result.jobs.sort((a,b)=>a.jobId.localeCompare(b.jobId));
    console.log(JSON.stringify({mode,elapsedMs,maxMainThreadTickGapMs:maxGap,ticks,jobCount:jobs.length,jobDigest:sha(JSON.stringify(jobs)),metadataBytes:result.stats.metadataBytes,node:process.version,maxRssKiB:process.resourceUsage().maxRSS,scope:'Process maxRSS includes worker threads; warm OS cache, shared CPU, no GC or disk-cache reset.'}));
  }finally{clearInterval(timer);await pool?.close();}
}else{
  const output=path.resolve(root,process.argv[2]||'.artifacts/mesh-catalog-performance');assert.ok(output.startsWith(path.join(root,'.artifacts')+path.sep)&&!fs.existsSync(output));fs.mkdirSync(output,{recursive:true});
  const data=path.join(output,'fixture'),store=new MeshJobStore(data),bodies=Array.from({length:60},(_,i)=>({bodyId:'body-'+i,kind:'solid',bodyIdentity:(i+1).toString(16).padStart(32,'0'),topologyIdentity:(i+100).toString(16).padStart(32,'0'),topologyRevision:1}));
  const metadata=[];
  for(let i=0;i<2000;i++){
    const documentId='project-'+Math.floor(i/500),job={version:1,jobId:'mesh-00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),documentId,state:'cancelled',createdAt:'2026-11-17T00:00:00.000Z',source:{version:1,documentId,revision:1,bodies},options:{repairMode:'conservative',qualityThreshold:.2}};
    const file=path.join(store.directory(job),'metadata.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(job),{flag:'wx'});metadata.push({file,sha256:sha(fs.readFileSync(file))});
  }
  async function run(mode){
    const child=spawn(process.execPath,[import.meta.filename,'--child',mode,data],{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr=(stderr+b).slice(-8192));
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});fs.writeFileSync(path.join(output,mode+'.log'),stdout+stderr,{flag:'wx'});assert.equal(code,0,stderr);return JSON.parse(stdout);
  }
  const reference=await run('reference'),threaded=await run('threaded');assert.equal(reference.jobCount,2000);assert.equal(threaded.jobCount,2000);assert.equal(reference.jobDigest,threaded.jobDigest);assert.equal(reference.metadataBytes,threaded.metadataBytes);
  for(const item of metadata)assert.equal(sha(fs.readFileSync(item.file)),item.sha256,'Recovery changed fixture metadata');
  const sources=['scripts/benchmark-mesh-catalog.mjs','gateway/mesh-catalog.mjs','gateway/mesh-job-store.mjs','gateway/mesh-artifact-pool.mjs','gateway/mesh-artifact-thread.mjs','gateway/project-mesh-service.mjs'];
  const report={format:'mesh-catalog-recovery-benchmark',version:1,ok:true,createdAt:new Date().toISOString(),fixture:{jobs:2000,documents:4,bodiesPerSource:60,metadataBytes:reference.metadataBytes,kind:'synthetic-valid-metadata-not-real-industrial-CAD'},reference,threaded,metadataUnchanged:true,sources:sources.map(file=>({file,sha256:sha(fs.readFileSync(path.join(root,file)))})),limits:['One sequential run per mode; reference first; warm OS cache and shared CPU.','Measures catalog scan/validation and worker transfer, not API, transient source cleanup or full startup.','Process memory includes worker threads; not a hard RSS, system, GPU or peak-per-worker claim.','No paid model requests, daily project access, real industrial geometry or tetrahedral workload.']};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report));
}
