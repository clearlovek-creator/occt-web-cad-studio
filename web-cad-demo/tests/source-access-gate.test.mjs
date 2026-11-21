import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceAccessGate} from '../gateway/source-access-gate.mjs';
const deferred=()=>{let resolve;const promise=new Promise(value=>resolve=value);return {promise,resolve};};

test('source activation waits for modeling readers and prevents newer readers overtaking it',async()=>{
  const gate=new SourceAccessGate(),first=deferred(),writer=deferred(),events=[];
  const reading=gate.read(async()=>{events.push('read-1');await first.promise;events.push('read-1-done');});
  const writing=gate.write(async()=>{events.push('write');await writer.promise;events.push('write-done');});
  const later=gate.read(async()=>events.push('read-2'));
  await Promise.resolve();assert.deepEqual(events,['read-1']);first.resolve();await reading;await Promise.resolve();assert.deepEqual(events,['read-1','read-1-done','write']);writer.resolve();await Promise.all([writing,later]);assert.deepEqual(events,['read-1','read-1-done','write','write-done','read-2']);
});

test('closing rejects queued access but lets an admitted transaction finish, including failures',async()=>{
  const gate=new SourceAccessGate(),active=deferred(),running=gate.read(()=>active.promise),queued=gate.write(()=>assert.fail('must not run'));
  const rejected=assert.rejects(queued,error=>error.code==='SERVICE_STOPPING');gate.close();active.resolve();await Promise.all([running,rejected]);await assert.rejects(gate.read(()=>{}),error=>error.code==='SERVICE_STOPPING');
  const other=new SourceAccessGate();await assert.rejects(other.write(()=>{throw Error('failed');}),/failed/);await other.read(()=>assert.equal(other.readers,1));assert.equal(other.readers,0);
});
