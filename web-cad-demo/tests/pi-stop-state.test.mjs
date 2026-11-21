import test from 'node:test';
import assert from 'node:assert/strict';
import {PiStopCoordinator} from '../app/modeling/pi-stop-state.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){const calls=[],states=[],f={};f.connection={async request(command){calls.push(command.type);return f.abort?f.abort():{};},async refresh(){calls.push('refresh');if(f.refresh)return f.refresh();}};f.stop=new PiStopCoordinator(f.connection,async()=>{calls.push('discover');if(f.discover)return f.discover();},state=>states.push(state));return {...f,calls,states,configure(value){Object.assign(f,value);}};}
test('one user stop sends one native abort and waits for task discovery plus native state before reporting receipt',async()=>{
  const f=fixture(),held=deferred();f.configure({abort:()=>held.promise});const first=f.stop.stop(),second=f.stop.stop();assert.equal(first,second);assert.deepEqual(f.calls,['abort']);assert.equal(f.states.at(-1).phase,'sending');held.resolve();await first;assert.deepEqual(f.calls,['abort','discover','refresh']);assert.equal(f.states.at(-1).phase,'checking');assert.match(f.states.at(-1).notice,/以建模任务的最终状态为准/);assert.doesNotMatch(f.states.at(-1).notice,/原工程已恢复|已成功取消/);await f.stop.stop();assert.equal(f.calls.filter(call=>call==='abort').length,1);
});
test('a lost abort reply stays uncertain and explicit checking only reads, never resends stop or modeling',async()=>{
  const f=fixture();f.configure({abort:()=>{throw Error('lost');}});await f.stop.stop();assert.equal(f.states.at(-1).phase,'uncertain');await f.stop.stop();assert.deepEqual(f.calls,['abort']);await f.stop.check();assert.deepEqual(f.calls,['abort','discover','refresh']);assert.equal(f.states.at(-1).phase,'checking');
});
test('an owner closed during abort cannot start late discovery or mutate a replacement UI',async()=>{
  const f=fixture(),held=deferred();f.configure({abort:()=>held.promise});const work=f.stop.stop(),count=f.states.length;f.stop.close();held.resolve();await work;assert.equal(f.states.length,count);assert.deepEqual(f.calls,['abort']);await f.stop.check();await f.stop.stop();assert.deepEqual(f.calls,['abort']);
});
test('closing during task discovery fences later native refresh and feedback',async()=>{
  const f=fixture(),held=deferred(),entered=deferred();f.configure({discover:()=>{entered.resolve();return held.promise;}});const work=f.stop.stop();await entered.promise;f.stop.close();held.resolve();await work;assert.deepEqual(f.calls,['abort','discover']);assert.equal(f.states.at(-1).phase,'sending');
});
test('a new run resets the stop latch, but a pending stop cannot be reset or duplicated',async()=>{
  const f=fixture(),held=deferred();f.configure({abort:()=>held.promise});const work=f.stop.stop();f.stop.reset();assert.equal(f.states.at(-1).phase,'sending');held.resolve();await work;f.stop.reset();assert.equal(f.states.at(-1).phase,'idle');await f.stop.stop();assert.equal(f.calls.filter(call=>call==='abort').length,2);
});
test('task discovery or snapshot failure is uncertain rather than false completion',async()=>{
  for(const kind of ['discover','refresh']){const f=fixture();f.configure({[kind]:()=>{throw Error('offline');}});await f.stop.stop();assert.equal(f.states.at(-1).phase,'uncertain');assert.equal(f.calls.filter(call=>call==='abort').length,1);assert.doesNotMatch(f.states.at(-1).notice,/已经停止|已恢复/);}
});
test('repeated checks share one read-only observation and close fences its rejection',async()=>{
  const f=fixture(),held=deferred();f.configure({discover:()=>held.promise});const first=f.stop.check();assert.equal(f.stop.check(),first);assert.deepEqual(f.calls,['discover']);f.stop.close();const count=f.states.length;held.reject(Error('late'));await first;assert.equal(f.states.length,count);assert.deepEqual(f.calls,['discover']);
});
