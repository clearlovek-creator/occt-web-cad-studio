import {parentPort,workerData} from 'node:worker_threads';
const close=parentPort.close.bind(parentPort);parentPort.close=()=>{};
await import(workerData.projectionFixtureTarget||'../../gateway/mesh-artifact-thread.mjs');
const control=new Int32Array(workerData.projectionControl);
// Hold the actual replied Worker, not the native V8 futex call. The referenced
// timer prevents an unresolved waitAsync promise from becoming an early exit.
// Readiness is published only after registering the shared release waiter.
const timer=setInterval(()=>{},1000);
try{const waiting=Atomics.waitAsync(control,0,0);Atomics.store(control,1,1);if(waiting.async)await waiting.value;}finally{clearInterval(timer);}
close();
