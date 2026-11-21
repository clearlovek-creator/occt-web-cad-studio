import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('native exact BRep evidence remains byte-compatible while streaming across bounded blocks',()=>{
  const root=path.resolve(import.meta.dirname,'..');assert.ok(process.env.GEOMETRY_WORKER_PATH,'Use the registered native test runner');
  const env={...process.env};const inherited=env.Path||env.PATH||'';delete env.Path;delete env.PATH;env.PATH=[path.resolve(root,'../install-mingw-ucrt64/win64/gcc/bin'),'C:/msys64/ucrt64/bin',inherited].join(path.delimiter);
  const result=spawnSync(path.join(path.dirname(process.env.GEOMETRY_WORKER_PATH),'fingerprint_tests.exe'),[],{env,input:'',windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,[result.error?.message,result.stderr,result.stdout].filter(Boolean).join('\n'));
  assert.match(result.stdout,/PASS SHA256 known vectors and exact legacy BRep parity before\/after triangulation/);
  assert.match(result.stdout,/PASS multi-block BRep evidence is complete with at most 64 KiB buffered payload/);
});
