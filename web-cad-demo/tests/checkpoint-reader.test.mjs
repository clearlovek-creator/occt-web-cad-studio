import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CheckpointReader} from '../gateway/checkpoint-reader.mjs';

function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-checkpoint-reader-'));t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});});return {directory,file:path.join(directory,'state-1-1-1.xbf')};}
const content=()=>{const bytes=Buffer.alloc(3*1024*1024+37,71);bytes.write('BINFILE');return bytes;};

test('large checkpoint hashing reads fixed chunks and always verifies the complete content without retaining it',t=>{
  const {file}=fixture(t),bytes=content();fs.writeFileSync(file,bytes);const reader=new CheckpointReader(),expected=createHash('sha256').update(bytes).digest('hex');
  assert.equal(reader.snapshot(file),expected);assert.equal(reader.snapshot(file),expected);
  const metrics=reader.metrics();assert.equal(metrics.geometryFiles,2);assert.equal(metrics.geometryBytes,bytes.length*2);assert.equal(metrics.readBufferBytes,1024*1024);assert.equal(metrics.strategy,'full-sha256-no-cache');assert.equal(metrics.rejectedFiles,0);
});

test('same-length content changes remain visible even when the write timestamp is restored',t=>{
  const {file}=fixture(t),bytes=content();fs.writeFileSync(file,bytes);const reader=new CheckpointReader(),before=reader.snapshot(file),stat=fs.statSync(file);
  bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);fs.utimesSync(file,stat.atime,stat.mtime);
  assert.notEqual(reader.snapshot(file),before,'No metadata cache may bypass full hashing');
});

test('a checkpoint changed during streaming is rejected instead of certifying mixed bytes',t=>{
  const {file}=fixture(t),bytes=content();fs.writeFileSync(file,bytes);const reader=new CheckpointReader(),original=fs.readSync;let changed=false;
  fs.readSync=function(...args){const result=original(...args);if(result>0&&!changed){changed=true;fs.appendFileSync(file,'changed');}return result;};
  try{assert.throws(()=>reader.snapshot(file),/changed during/);assert.equal(reader.metrics().rejectedFiles,1);}
  finally{fs.readSync=original;}
});

test('short files, directories and invalid XBF headers fail closed',t=>{
  const {file,directory}=fixture(t),reader=new CheckpointReader();fs.writeFileSync(file,'BINFILE');assert.throws(()=>reader.snapshot(file),/invalid file type or length/);
  fs.writeFileSync(file,Buffer.alloc(100));assert.throws(()=>reader.snapshot(file),/not a readable XBF/);assert.throws(()=>reader.snapshot(directory),/invalid file type or length/);
});
