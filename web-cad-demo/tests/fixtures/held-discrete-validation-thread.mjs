import {parentPort,workerData} from 'node:worker_threads';
const close=parentPort.close.bind(parentPort);parentPort.close=()=>{};
await import(workerData.validationFixtureTarget);
// The real validator has replied, but its exact worker has NOT exited.
// Hold only in this test-owned wrapper, never in the product implementation.
const control=new Int32Array(workerData.validationFixtureControl);
Atomics.store(control,1,1);Atomics.wait(control,0,0);close();
