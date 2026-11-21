import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('native generated topology uses proven histories and rejects incomplete or ambiguous evidence',()=>{
  const root=path.resolve(import.meta.dirname,'..'),worker=process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe');
  const env={...process.env,PATH:[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:\\msys64\\ucrt64\\bin',process.env.PATH].join(path.delimiter)};
  const r=spawnSync(path.join(path.dirname(worker),'generated_topology_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(r.status,0,[r.stdout,r.stderr,r.error?.message].filter(Boolean).join('\n'));assert.match(r.stdout,/PASS generated topology history/);
});
