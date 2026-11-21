import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('native curved sweeps validate exact circles/arcs, G1 continuity, direction and explicit placement',()=>{
  const root=path.resolve(import.meta.dirname,'..'),worker=process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'),env={...process.env},inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  const result=spawnSync(path.join(path.dirname(worker),'curve_sweep_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(result.status,0,`${result.error?.message||''}\n${result.stderr}\n${result.stdout}`);
  for(const text of ['exact closed circular path','real arc length','ordered G1 path validation','actual placement refuses'])assert.ok(result.stdout.includes(text));
});
