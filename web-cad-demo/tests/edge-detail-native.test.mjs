import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('native thin-plate fillet and chamfer support local dimensions and exact upstream/detail recomputation',()=>{
  const directory=path.dirname(process.env.GEOMETRY_WORKER_PATH||path.resolve('geometry-worker/build/occt_geometry_worker.exe')),env={...process.env},inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=[path.resolve('../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  const result=spawnSync(path.join(directory,'edge_detail_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(result.status,0,`${result.error?.message||''}\n${result.stdout}\n${result.stderr}`);assert.match(result.stdout,/PASS thin plate fillet/);assert.match(result.stdout,/PASS thin plate chamfer/);assert.match(result.stdout,/PASS shallow planar corner/);
});
