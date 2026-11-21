import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {stopTestChild} from './helpers/stop-test-child.mjs';
const root=path.resolve(import.meta.dirname,'..');
function launch(data,extra={}){
  const child=spawn(process.execPath,['tests/fixtures/pi-rpc-fixture.mjs','--session-dir',data,'--continue'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...extra}});
  let buffer='',diagnostics='';const messages=[];child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});child.stderr.on('data',chunk=>diagnostics=(diagnostics+chunk).slice(-8192));
  const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  async function rpc(command){child.stdin.write(JSON.stringify(command)+'\n');const deadline=Date.now()+5000;for(;;){const value=messages.find(value=>value.type==='response'&&value.id===command.id);if(value)return value;assert.equal(child.exitCode,null,diagnostics);assert.ok(Date.now()<deadline,'Fixture response unconfirmed: '+diagnostics);await new Promise(resolve=>setTimeout(resolve,5));}}
  return {child,rpc,ended};
}
test('test transport history is atomic across an actual process exit during write and prompt acknowledgement follows persistence',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-pi-fixture-persist-'));let current;
  try{
    current=launch(data);await current.rpc({id:'first',type:'prompt',message:'fixture:pending original'});const file=path.join(data,'fixture-history.json'),original=fs.readFileSync(file);assert.equal(JSON.parse(original)[0].content[0].text,'fixture:pending original');current.child.stdin.end();assert.equal(await current.ended,0);current=null;
    current=launch(data,{CAD_TEST_PI_FIXTURE_EXIT_BEFORE_RENAME:'1'});current.child.stdin.write(JSON.stringify({id:'interrupted',type:'prompt',message:'fixture:pending interrupted'})+'\n');assert.equal(await current.ended,86);current=null;assert.deepEqual(fs.readFileSync(file),original);assert.ok(fs.readdirSync(data).some(name=>name.endsWith('.tmp')));
    current=launch(data);const result=await current.rpc({id:'restored',type:'get_messages'});assert.equal(result.data.messages.length,1);assert.equal(result.data.messages[0].content[0].text,'fixture:pending original');current.child.stdin.end();assert.equal(await current.ended,0);current=null;
  }finally{if(current)await stopTestChild(current.child);assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-pi-fixture-persist-/);fs.rmSync(data,{recursive:true,force:true});}
});
