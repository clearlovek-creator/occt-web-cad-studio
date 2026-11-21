import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('native suspended topology verifies proof parity, reordered entities, ambiguity, ownership and private persistence',()=>{
  const root=path.resolve(import.meta.dirname,'..'),worker=process.env.GEOMETRY_WORKER_PATH||path.join(root,'geometry-worker/build/occt_geometry_worker.exe'),env={...process.env};
  const inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  const result=spawnSync(path.join(path.dirname(worker),'suspended_topology_tests.exe'),[],{env,windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,`${result.error?.message||''}\n${result.stderr}\n${result.stdout}\nRun npm run build:worker to build the native recovery target.`);
  for(const proof of ['all single Face/Edge selections','real reordered topology','ambiguous provenance','ownership are checked','proven raw-property recovery','exact archive re-certification retains original evidence','malformed stored proof is atomic'])assert.ok(result.stdout.includes(proof),proof);
});
