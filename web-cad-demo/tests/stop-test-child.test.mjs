import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {stopTestChild} from './helpers/stop-test-child.mjs';
test('a requested process termination is not treated as an observed process exit',async()=>{
  const child=new EventEmitter();Object.assign(child,{killed:true,exitCode:null,signalCode:null});let finished=false;
  const pending=stopTestChild(child).then(()=>finished=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);child.emit('exit',0);await pending;assert.equal(finished,true);
});
test('an observation timeout rejects cleanup rather than pretending the process stopped',async()=>{
  const child=new EventEmitter();let kills=0;Object.assign(child,{killed:false,exitCode:null,signalCode:null,kill(){this.killed=true;kills++;}});
  await assert.rejects(stopTestChild(child,{timeoutMs:10}),/preserve its data directory/);assert.equal(kills,1);assert.equal(child.listenerCount('exit'),0);
});
