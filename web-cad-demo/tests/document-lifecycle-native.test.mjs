import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('native document ownership stays bounded across reset, failed restore and shared-file loads; failed reads never publish staged state',()=>{
  const root=path.resolve(import.meta.dirname,'..'),worker=process.env.GEOMETRY_WORKER_PATH || path.join(root,'geometry-worker','build','occt_geometry_worker.exe');
  const env={...process.env,PATH:[path.resolve(root,'..','install-mingw-ucrt64','win64','gcc','bin'),'C:\\msys64\\ucrt64\\bin',process.env.PATH].join(path.delimiter)};
  const result=spawnSync(path.join(path.dirname(worker),'document_lifecycle_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr || result.error?.message || result.stdout);assert.match(result.stdout,/PASS resets, shared-file restores/);
  assert.match(result.stdout,/PASS native Body opacity is lossless, legacy evidence is retained, missing evidence defaults and corrupt display snapshots fail atomically/);
});
