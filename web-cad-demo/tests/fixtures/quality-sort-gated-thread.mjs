import fs from 'node:fs';
import { workerData } from 'node:worker_threads';
// Test-only resource downsizing and pause inside real run/merge IO. No fake reply.
if (workerData.merging) {
    const { QualityExternalSort } = await import('../../gateway/mesh-quality-sort.mjs'), add = QualityExternalSort.prototype.add;
    QualityExternalSort.prototype.add = function (row) { this.runRecords = 2; this.fanIn = 2; return add.call(this, row); };
}
const control = new Int32Array(workerData.sortBarrier), open = fs.openSync, write = fs.writeSync, fds = new Set();
let blocked = false;
fs.openSync = (file, ...args) => {
    const fd = open(file, ...args);
    if ((workerData.merging ? /sort-50\.run$/ : /sort-\d+\.run$/).test(String(file)) && args[0] === 'wx')
        fds.add(fd);
    return fd;
};
fs.writeSync = (fd, ...args) => {
    const result = write(fd, ...args);
    if (fds.has(fd) && !blocked) {
        blocked = true;
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        Atomics.wait(control, 1, 0);
    }
    return result;
};
await import(workerData.moduleUrl);
