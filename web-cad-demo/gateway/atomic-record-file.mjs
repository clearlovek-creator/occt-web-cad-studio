import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const IO_CODES = new Set(['EACCES', 'EBADF', 'EBUSY', 'EDQUOT', 'EEXIST', 'EFBIG', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE', 'ENAMETOOLONG', 'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM', 'EROFS', 'EXDEV']);
const STAGES = new Set(['validate', 'encode', 'open', 'write', 'sync', 'close', 'replace']);
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const regular = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
const stable = (a, b) => identity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function parentMatches(directory, expected) {
    const actual = fs.lstatSync(directory, {bigint: true});
    return actual.isDirectory() && !actual.isSymbolicLink() && identity(actual, expected);
}
function absent(file) {
    try { fs.lstatSync(file); return false; }
    catch (error) { return error?.code === 'ENOENT'; }
}

/** Read-only proof: equal JSON alone is not proof that our staged file was published. */
function publishedExactly(file, temporary, bytes, staged, directory, parent) {
    let handle;
    try {
        if (!parentMatches(directory, parent) || !absent(temporary)) return false;
        const before = fs.lstatSync(file, {bigint: true});
        if (!regular(before) || !identity(before, staged) || before.size !== BigInt(bytes.length)) return false;
        handle = fs.openSync(file, 'r');
        const opened = fs.fstatSync(handle, {bigint: true});
        if (!regular(opened) || !stable(before, opened)) return false;
        const buffer = Buffer.alloc(bytes.length + 1);
        let size = 0, count;
        while (size < buffer.length && (count = fs.readSync(handle, buffer, size, buffer.length - size, size)) > 0) size += count;
        const after = fs.fstatSync(handle, {bigint: true});
        const named = fs.lstatSync(file, {bigint: true});
        if (size !== bytes.length || !buffer.subarray(0, size).equals(bytes) || !regular(after) || !regular(named) || !stable(opened, after) || !stable(after, named)) return false;
        fs.closeSync(handle); handle = undefined;
        return parentMatches(directory, parent) && absent(temporary);
    } catch { return false; }
    finally { if (handle !== undefined) try { fs.closeSync(handle); } catch { /* The primary publication result remains authoritative. */ } }
}

export function recordPersistenceDiagnostic(error) {
    return {
        stage: STAGES.has(error?.stage) ? error.stage : 'validate',
        ioCode: IO_CODES.has(error?.ioCode) ? error.ioCode : 'UNKNOWN',
        publication: ['not-started', 'unconfirmed'].includes(error?.publication) ? error.publication : 'not-started',
        cleanup: ['not-needed', 'removed', 'retained', 'failed'].includes(error?.cleanup) ? error.cleanup : 'not-needed',
        at: new Date().toISOString(),
    };
}

/** One bounded write attempt. Never retries a rename or replays a modeling command. */
export function writeAtomicRecord(file, record, {maxBytes = 32768, createOnly = false} = {}) {
    const directory = path.dirname(file), temporary = file + '.' + randomUUID() + '.tmp';
    let stage = 'validate', parent, bytes, handle, owned, staged, replacementAttempted = false;
    try {
        parent = fs.lstatSync(directory, {bigint: true});
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Invalid task directory');
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024 || typeof createOnly !== 'boolean') throw Error('Invalid record byte limit');
        if (createOnly && !absent(file)) throw Object.assign(Error('Record already exists'), {code: 'EEXIST'});
        if (!createOnly && !absent(file) && !regular(fs.lstatSync(file, {bigint: true}))) throw Error('Invalid target record');
        stage = 'encode';
        bytes = Buffer.from(JSON.stringify(record));
        if (bytes.length > maxBytes) throw Object.assign(Error('Record exceeds the reader limit'), {code: 'EFBIG'});
        stage = 'open';
        handle = fs.openSync(temporary, 'wx', 0o600);
        owned = fs.fstatSync(handle, {bigint: true});
        if (!regular(owned) || !parentMatches(directory, parent)) throw Error('Invalid staged task record');
        stage = 'write';
        fs.writeFileSync(handle, bytes);
        stage = 'sync';
        fs.fsyncSync(handle);
        staged = fs.fstatSync(handle, {bigint: true});
        if (!regular(staged) || !identity(owned, staged) || staged.size !== BigInt(bytes.length)) throw Error('Staged task record changed');
        stage = 'close';
        fs.closeSync(handle); handle = undefined;
        stage = 'replace';
        if (!parentMatches(directory, parent)) throw Error('Task directory changed');
        const named = fs.lstatSync(temporary, {bigint: true});
        if (!regular(named) || !stable(staged, named)) throw Error('Staged task record changed');
        if (createOnly && !absent(file)) throw Object.assign(Error('Record already exists'), {code: 'EEXIST'});
        replacementAttempted = true;
        fs.renameSync(temporary, file);
        // Successful rename consumed our temporary file. Do not run a second,
        // unnecessary filesystem mutation that could turn success into failure.
        return {reconciled: false};
    } catch (cause) {
        if (replacementAttempted && publishedExactly(file, temporary, bytes, staged, directory, parent)) return {reconciled: true};
        if (handle !== undefined) try { fs.closeSync(handle); } catch { /* Preserve the original failure. */ }
        let cleanup = owned ? 'retained' : 'not-needed';
        if (owned) {
            try {
                if (parentMatches(directory, parent)) {
                    const named = fs.lstatSync(temporary, {bigint: true});
                    if (regular(named) && identity(named, owned)) { fs.unlinkSync(temporary); cleanup = 'removed'; }
                }
            } catch (error) { cleanup = error?.code === 'ENOENT' ? 'not-needed' : 'failed'; }
        }
        const error = new Error('Task record publication failed');
        const ioCode = IO_CODES.has(cause?.code) ? cause.code : 'UNKNOWN';
        Object.assign(error, {code: ioCode === 'UNKNOWN' ? 'ATOMIC_RECORD_WRITE_FAILED' : ioCode, stage, ioCode, publication: replacementAttempted ? 'unconfirmed' : 'not-started', cleanup});
        throw error;
    }
}
