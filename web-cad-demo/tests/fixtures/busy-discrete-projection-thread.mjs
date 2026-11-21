import {parentPort,workerData} from 'node:worker_threads';
const close=parentPort.close.bind(parentPort);parentPort.close=()=>{};
await import(workerData.projectionFixtureTarget||'../../gateway/mesh-artifact-thread.mjs');
// Test the product's real forced termination while JS is actively executing,
// separately from the asynchronous hold used for reply/exit publication races.
const control=new Int32Array(workerData.projectionControl);Atomics.store(control,1,1);
while(Atomics.load(control,0)===0){/* Only the owning test can release this gate. */}
close();
