import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {childExit,waitChildExit} from '../gateway/child-exit.mjs';
test('an exit timeout retains the same live process observation for a later verified wait',async()=>{
  const child=Object.assign(new EventEmitter(),{pid:123,exitCode:null,signalCode:null});await assert.rejects(waitChildExit(child,{timeoutMs:10}),error=>error.code==='CHILD_STOP_UNCONFIRMED');const original=childExit(child);assert.equal(childExit(child),original);let finished=false;const next=waitChildExit(child).then(()=>finished=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);child.emit('exit',0);await next;assert.equal(finished,true);assert.equal(child.listenerCount('exit'),0);
});
test('pipe closure cannot masquerade as exit of a known OS process',async()=>{
  const child=Object.assign(new EventEmitter(),{pid:123,exitCode:null,signalCode:null});let finished=false;const stopped=childExit(child).then(()=>finished=true);child.emit('close');await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);child.emit('exit',0);await stopped;assert.equal(finished,true);
});
