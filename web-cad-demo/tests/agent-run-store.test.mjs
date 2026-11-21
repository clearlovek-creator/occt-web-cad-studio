import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AgentRunStore} from '../gateway/agent-run-store.mjs';
test('shutdown interrupts owned runs once and rejects late success or new execution',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-run-shutdown-'));
  try{const store=new AgentRunStore(root);store.begin({runId:'current'});assert.equal(store.stop(),0);assert.equal(store.get('current').status,'interrupted');store.update('current',{status:'complete'});assert.equal(store.get('current').status,'interrupted');assert.throws(()=>store.begin({runId:'later'}),error=>error.code==='SERVICE_STOPPING');assert.equal(JSON.parse(fs.readFileSync(store.filePath('current'))).status,'interrupted');}
  finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
test('historical unfinished ledgers are shown interrupted after restart without rewriting their original evidence',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-run-recovery-'));
  try{const old=new AgentRunStore(root);old.begin({runId:'before-restart'});const file=old.filePath('before-restart'),bytes=fs.readFileSync(file),next=new AgentRunStore(root);assert.equal(next.get('before-restart').status,'interrupted');assert.equal(next.get('before-restart').recovered,true);next.stop();assert.deepEqual(fs.readFileSync(file),bytes);}
  finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
