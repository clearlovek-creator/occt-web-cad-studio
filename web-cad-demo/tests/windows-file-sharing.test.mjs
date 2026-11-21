import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {denyWindowsFileRead} from './helpers/windows-file-sharing.mjs';
test('the owned Windows sharing fixture locks deep imported-asset paths and confirms exit before releasing them',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-long-sharing-')),directory=path.join(root,'a'.repeat(100),'b'.repeat(100));let held;
  try{fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'original-'+ 'c'.repeat(50)+'.msh');fs.writeFileSync(file,'original bytes');assert.ok(file.length>260);held=await denyWindowsFileRead(file);assert.throws(()=>fs.readFileSync(file),error=>['EACCES','EPERM','EBUSY'].includes(error.code));await held.release();held=null;assert.equal(fs.readFileSync(file,'utf8'),'original bytes');}
  finally{if(held)await held.release();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-long-sharing-/);fs.rmSync(root,{recursive:true,force:true});}
});
