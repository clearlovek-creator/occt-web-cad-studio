import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { streamCheckedMesh } from '../gateway/mesh-download.mjs';
async function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-mesh-download-')), file = path.join(root, 'test.msh'), bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 36), proof = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    fs.writeFileSync(file, bytes);
    const response = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, received: [], writeHead(_status, headers) { this.headersSent = true; this.headers = headers; }, write(bytes) { this.received.push(Buffer.from(bytes)); return true; }, end() { this.ended = true; }, destroy() { this.destroyed = true; this.emit('close'); } });
    try {
        await run({ file, bytes, proof, response });
    }
    finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cad-mesh-download-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
test('checked mesh downloads retain exact bytes and disclose the expected content digest', async () => fixture(async (f) => { await streamCheckedMesh(f.file, f.proof, f.response, {}); assert.equal(f.response.ended, true); assert.equal(f.response.headers['X-Content-SHA256'], f.proof.sha256); assert.deepEqual(Buffer.concat(f.response.received), f.bytes); }));
test('a mutation of an unread tail cannot complete a checked download and the final block is withheld', async () => fixture(async (f) => {
    const write = f.response.write.bind(f.response);
    let mutated = false;
    // More than the stream's bounded read-ahead. Changing already-buffered
    // bytes is not a failure if the delivered old snapshot is still correct.
    f.response.write = bytes => { const result = write(bytes); if (!mutated) {
        mutated = true;
        const fd = fs.openSync(f.file, 'r+');
        try {
            fs.writeSync(fd, Buffer.from([255]), 0, 1, f.bytes.length - 1);
        }
        finally {
            fs.closeSync(fd);
        }
    } return result; };
    await assert.rejects(streamCheckedMesh(f.file, f.proof, f.response, {}));
    assert.equal(mutated, true);
    assert.equal(f.response.destroyed, true);
    assert.equal(f.response.ended, undefined);
    assert.ok(Buffer.concat(f.response.received).length < f.proof.bytes);
}));
test('a slow receiver observes backpressure and a closed receiver releases the open file', async () => fixture(async (f) => { f.response.write = () => { setImmediate(() => f.response.destroy()); return false; }; await assert.rejects(streamCheckedMesh(f.file, f.proof, f.response, {})); assert.equal(f.response.ended, undefined); fs.renameSync(f.file, f.file + '.closed'); }));
