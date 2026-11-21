import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('native STEP import is atomic and preserves tested mixed topology with replay, metadata, placement and unit checks',()=>{
  const root=path.resolve(import.meta.dirname,'..'),worker=process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'),env={...process.env,PATH:[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:\\msys64\\ucrt64\\bin',process.env.PATH].join(path.delimiter)};
  const result=spawnSync(path.join(path.dirname(worker),'step_import_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(result.status,0,[result.error?.message,result.stderr,result.stdout].filter(Boolean).join('\n'));for(const name of ['failed STEP parse','mixed topology STEP','multiple solid import','located occurrences','new sources reject','flat export keeps','legacy decomposition','legacy STEP naming','explicit legacy naming upgrade','legacy Face coordinates','legacy naming upgrade rejects','legacy naming upgrade preserves archived','legacy naming upgrade rejects a replay','legacy naming upgrade never fabricates','STEP file units'])assert.ok(result.stdout.includes('PASS '+name),name);
  assert.ok(result.stdout.includes('PASS legacy archived Pattern topology is re-certified without restoring live geometry or activating orphaned attributes'));
});
