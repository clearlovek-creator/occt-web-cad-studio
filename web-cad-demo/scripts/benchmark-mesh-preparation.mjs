import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MeshArtifactPool } from '../gateway/mesh-artifact-pool.mjs';
import { MeshJobStore } from '../gateway/mesh-job-store.mjs';
import { preparationPaths, readPreparationManifest } from '../gateway/mesh-preparation-files.mjs';
import { diagnosticSource } from '../tests/helpers/mesh-preparation-fixture.mjs';

const root=path.resolve(import.meta.dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cad-preparation-bench-'));
const sizes=(process.env.CAD_PREPARATION_MIB||'16,128,256').split(',').map(Number),cases=[];
assert.ok(sizes.length<=8&&sizes.every(size=>Number.isSafeInteger(size)&&size>=1&&size<=1024));
let pool;
try{
    for(const mib of sizes){
        const data=path.join(scratch,String(mib));fs.mkdirSync(data,{recursive:true});
        const store=new MeshJobStore(data);pool=new MeshArtifactPool({dataDir:data});
        const source={...diagnosticSource,documentId:'preparation_benchmark'},job={jobId:'mesh-'+crypto.randomUUID(),documentId:source.documentId,source,state:'preparing',kind:'preparation'};
        const files=preparationPaths(data,job,{create:true}),block=Buffer.alloc(1024*1024,0x41),hash=crypto.createHash('sha256');
        const fd=fs.openSync(files.source,'wx');try{for(let i=0;i<mib;i++){fs.writeSync(fd,block);hash.update(block);}}finally{fs.closeSync(fd);}
        const expected={bytes:mib*block.length,sha256:hash.digest('hex')};
        fs.writeFileSync(files.sourceManifest,JSON.stringify({revision:source.revision,bodies:source.bodies}));
        const samples=[];
        for(const variant of ['baseline','threaded']){
            let gap=0,last=performance.now(),ticks=0;
            const timer=setInterval(()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now;ticks++;},5);
            await new Promise(resolve=>setTimeout(resolve,10));
            const start=performance.now();let result,elapsedMs;
            try{
                result=variant==='baseline'?(readPreparationManifest(files.sourceManifest,source),{artifact:store.writePrepared(job,files.source,files.sourceManifest)}):await pool.execute({operation:'capture-prepared',job});
            }finally{elapsedMs=performance.now()-start;await new Promise(resolve=>setTimeout(resolve,10));clearInterval(timer);}
            assert.deepEqual(result.artifact.preparedBrep,expected);
            samples.push({variant,elapsedMs,maxMainThreadTimerGapMs:gap,timerTicks:ticks,rssSnapshot:process.memoryUsage().rss});
            // The next variant may not overwrite the first variant's originals.
            fs.unlinkSync(files.brep);fs.unlinkSync(files.manifest);
        }
        cases.push({sourceMiB:mib,sourceProof:expected,samples});console.log(JSON.stringify(cases.at(-1)));
        await pool.close();pool=null;
    }
    const sources=Object.fromEntries(['gateway/mesh-preparation-files.mjs','gateway/mesh-artifact-pool.mjs','gateway/mesh-artifact-thread.mjs','gateway/mesh-job-store.mjs','scripts/benchmark-mesh-preparation.mjs'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
    const output=path.join(root,'.artifacts/performance/mesh-preparation.json');fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify({node:process.version,environment:{cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length},scope:'Synthetic repeated-byte file copy/hash I/O, not valid BREP repair/mesher throughput or peak RSS. Warm OS cache; baseline runs first; non-exclusive CPU.',sources,cases},null,2));console.log(output);
}finally{
    await pool?.close();assert.equal(path.dirname(scratch),path.resolve(os.tmpdir()));assert.match(path.basename(scratch),/^cad-preparation-bench-/);fs.rmSync(scratch,{recursive:true,force:true});
}
