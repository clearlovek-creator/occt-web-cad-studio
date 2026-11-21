import fs from 'node:fs';
import { workerData } from 'node:worker_threads';
// Test-only barrier inside the real copy loop, after exclusive staging opens.
const control=new Int32Array(workerData.copyBarrier),open=fs.openSync,read=fs.readSync;
let copying=false,blocked=false;
fs.openSync=(file,...args)=>{const fd=open(file,...args);if(String(file).endsWith('.result.tmp.brep')&&args[0]==='wx')copying=true;return fd;};
fs.readSync=(...args)=>{const count=read(...args);if(copying&&!blocked){blocked=true;Atomics.store(control,0,1);Atomics.notify(control,0);Atomics.wait(control,1,0);}return count;};
await import(workerData.moduleUrl);
