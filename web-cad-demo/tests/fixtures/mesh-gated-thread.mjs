import { parentPort, workerData } from 'node:worker_threads';
// Test-only startup barrier. The imported module is the actual material worker.
await new Promise(resolve => parentPort.once('message', resolve));
await import(workerData.moduleUrl);
