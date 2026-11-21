import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('legacy native coordinate records preserve raw snapshot axes and reject incomplete or wrong-kind persistent anchors',()=>{
  const root=path.resolve(import.meta.dirname,'..');
  const worker=process.env.GEOMETRY_WORKER_PATH || path.join(root,'geometry-worker','build','occt_geometry_worker.exe');
  const env={...process.env,PATH:[path.resolve(root,'..','install-mingw-ucrt64','win64','gcc','bin'),'C:\\msys64\\ucrt64\\bin',process.env.PATH].join(path.delimiter)};
  const result=spawnSync(path.join(path.dirname(worker),'coordinate_reference_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr || result.error?.message || result.stdout);assert.match(result.stdout,/PASS legacy coordinate snapshots/);
});
