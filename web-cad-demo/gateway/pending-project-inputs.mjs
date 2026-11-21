import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export class PendingProjectInputError extends Error {
    constructor(code, message) { super(message); this.name = 'PendingProjectInputError'; this.code = code; this.status = code === 'PROJECT_INPUT_CAPACITY' ? 429 : code === 'PROJECT_INPUT_SIZE' ? 413 : ['PROJECT_INPUT_CHANGED', 'PROJECT_INPUT_CANCELLED'].includes(code) ? 409 : code === 'PROJECT_INPUT_TIMEOUT' ? 408 : code === 'SERVICE_STOPPING' || ['PROJECT_INPUT_UNAVAILABLE', 'PROJECT_INPUT_WRITE_FAILED'].includes(code) ? 503 : 400; }
}
const fault = (code, message) => new PendingProjectInputError(code, message);
const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
const sameIdentity = (left, right) => Object.keys(left).every(key => left[key] === right[key]);
const NAME = /^[a-f0-9-]{36}\.upload$/;
/** Private upload staging. Never retains a full package Buffer while queued. */
export class PendingProjectInputs {
    constructor(dataDir, { maxBytes = 512 * 1024 * 1024, maxSlots = 2, timeoutMs = 120000, directoryName = 'pending-project-inputs' } = {}) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3 || !Number.isSafeInteger(maxSlots) || maxSlots < 1 || maxSlots > 8 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
            throw fault('PROJECT_INPUT_CONFIG_INVALID', '工程输入暂存预算无效。');
        if (!['pending-project-inputs', 'pending-step-inputs'].includes(directoryName))
            throw fault('PROJECT_INPUT_CONFIG_INVALID', '输入暂存目录配置无效。');
        this.root = path.join(dataDir, directoryName);
        this.sourceRoot = directoryName === 'pending-step-inputs' ? path.resolve(dataDir, 'imports') : null;
        this.maxBytes = maxBytes;
        this.maxSlots = maxSlots;
        this.timeoutMs = timeoutMs;
        this.leases = new Map();
        this.orphans = new Map();
        this.lastError = null;
        this.closed = false;
        fs.mkdirSync(this.root, { recursive: true });
        this.refresh();
    }
    checkRoot() {
        const stat = fs.lstatSync(this.root);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw fault('PROJECT_INPUT_UNAVAILABLE', '工程输入暂存目录类型异常，已停止新上传。');
    }
    checkedStat(file) {
        const stat = fs.lstatSync(file, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
            throw fault('PROJECT_INPUT_UNAVAILABLE', '工程输入暂存材料不是独占普通文件。');
        return stat;
    }
    refresh() {
        this.checkRoot();
        const entries = fs.readdirSync(this.root);
        if (entries.length > 64)
            throw fault('PROJECT_INPUT_CAPACITY', '工程输入暂存材料过多，需检查保留材料；不会自动删除。');
        const orphans = new Map();
        for (const name of entries) {
            if (!NAME.test(name))
                throw fault('PROJECT_INPUT_UNAVAILABLE', '工程输入暂存区含未知材料，已保留并停止新上传。');
            if (this.leases.has(name))
                continue;
            const size = this.checkedStat(path.join(this.root, name)).size;
            if (size > BigInt(this.maxBytes))
                throw fault('PROJECT_INPUT_CAPACITY', '工程输入保留材料超过暂存预算，不会自动删除。');
            orphans.set(name, Number(size));
        }
        this.orphans = orphans;
    }
    status() {
        return { closed: this.closed, slots: this.leases.size, retainedSlots: this.orphans.size, reservedBytes: [...this.leases.values()].reduce((sum, item) => sum + item.chargedBytes, 0), retainedBytes: [...this.orphans.values()].reduce((sum, size) => sum + size, 0), maxBytes: this.maxBytes, maxSlots: this.maxSlots, lastError: this.lastError };
    }
    async receive(readable, { maxBytes, declaredBytes, signal } = {}) {
        if (this.closed)
            throw fault('SERVICE_STOPPING', '后台正在停止，未接收新的工程输入。');
        if (signal?.aborted)
            throw fault('PROJECT_INPUT_CANCELLED', '文件上传已取消，未开始几何导入。');
        this.refresh();
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > maxBytes))
            throw fault('PROJECT_INPUT_SIZE', '工程上传大小无效或超过单文件预算。');
        const reservation = declaredBytes ?? maxBytes, capacity = this.status();
        if (capacity.slots + capacity.retainedSlots >= this.maxSlots || reservation > this.maxBytes - capacity.reservedBytes - capacity.retainedBytes)
            throw fault('PROJECT_INPUT_CAPACITY', '工程输入暂存预算已满，本次上传尚未接收；请等待或检查保留材料。');
        const name = randomUUID() + '.upload', file = path.join(this.root, name);
        let released;
        const done = new Promise(resolve => { released = resolve; });
        const lease = { name, file, readable, done, released, chargedBytes: reservation, bytes: 0, proof: null, hash: null, tampered: false };
        this.leases.set(name, lease);
        let handle, initial, timer;
        // Shutdown can destroy the stream while asynchronous open has not yet
        // installed the async iterator's error listener. Keep that event observed;
        // the iterator (or the explicit closed check) still rejects the upload.
        const guardError = () => { };
        const abort = () => readable.destroy(fault('PROJECT_INPUT_CANCELLED', '文件上传已取消，未开始几何导入。'));
        try {
            readable.on('error', guardError);
            signal?.addEventListener('abort', abort, { once: true });
            handle = await fsp.open(file, 'wx', 0o600);
            initial = identity(await handle.stat({ bigint: true }));
            if (this.closed)
                throw fault('SERVICE_STOPPING', '后台停止，工程输入上传已中断；未开始打开工程。');
            if (signal?.aborted)
                throw fault('PROJECT_INPUT_CANCELLED', '文件上传已取消，未开始几何导入。');
            const digest = createHash('sha256');
            timer = setTimeout(() => readable.destroy(fault('PROJECT_INPUT_TIMEOUT', '工程输入上传超过截止时间，尚未开始打开工程。')), this.timeoutMs);
            for await (const raw of readable) {
                if (signal?.aborted)
                    throw fault('PROJECT_INPUT_CANCELLED', '文件上传已取消，未开始几何导入。');
                const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                if (lease.bytes + bytes.length > maxBytes || declaredBytes !== undefined && lease.bytes + bytes.length > declaredBytes)
                    throw fault('PROJECT_INPUT_SIZE', '工程上传超过声明大小或单文件预算。');
                lease.bytes += bytes.length;
                digest.update(bytes);
                let offset = 0;
                while (offset < bytes.length) {
                    const written = await handle.write(bytes, offset, bytes.length - offset);
                    if (!written.bytesWritten)
                        throw fault('PROJECT_INPUT_WRITE_FAILED', '工程输入暂存写入未前进。');
                    offset += written.bytesWritten;
                }
            }
            if (!lease.bytes || declaredBytes !== undefined && lease.bytes !== declaredBytes)
                throw fault('PROJECT_INPUT_SIZE', '工程上传为空或未达到声明大小。');
            clearTimeout(timer);
            await handle.sync();
            await handle.close();
            handle = null;
            if (signal?.aborted)
                throw fault('PROJECT_INPUT_CANCELLED', '文件上传已取消，未开始几何导入。');
            lease.proof = identity(this.checkedStat(file));
            lease.hash = digest.digest('hex');
            lease.chargedBytes = lease.bytes;
            return { bytes: lease.bytes, read: () => this.read(lease), release: options => this.release(lease,options), ...(this.sourceRoot ? { copyTo: (target, options) => this.copyTo(lease, target, options) } : {}) };
        }
        catch (error) {
            clearTimeout(timer);
            await handle?.close();
            try {
                const stat = this.checkedStat(file);
                if (initial && stat.dev === initial.dev && stat.ino === initial.ino)
                    fs.unlinkSync(file);
                else
                    lease.tampered = true;
            }
            catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT')
                    lease.tampered = true;
            }
            this.leases.delete(name);
            lease.released();
            if (lease.tampered)
                this.orphans.set(name, lease.bytes);
            if (error instanceof PendingProjectInputError)
                throw error;
            if (signal?.aborted)
                throw fault('PROJECT_INPUT_CANCELLED', '文件上传已取消，未开始几何导入。');
            throw fault('PROJECT_INPUT_WRITE_FAILED', '工程上传未完整暂存，尚未开始打开工程。');
        }
        finally {
            readable.off('error', guardError);
            signal?.removeEventListener('abort', abort);
        }
    }
    async copyTo(lease, target, { signal } = {}) {
        if (!this.sourceRoot || path.dirname(path.resolve(target)) !== this.sourceRoot || !/^[-A-Za-z0-9_]{1,64}-\d+-\d+-\d+\.step$/.test(path.basename(target)))
            throw fault('PROJECT_INPUT_UNAVAILABLE', 'STEP 来源目标必须是受管目录内的新文件。');
        if (!this.leases.has(lease.name) || lease.copyStarted)
            throw fault('PROJECT_INPUT_UNAVAILABLE', '该上传材料已使用或释放，不能重复安装。');
        lease.copyStarted = true;
        fs.mkdirSync(this.sourceRoot, { recursive: true });
        const root = fs.lstatSync(this.sourceRoot);
        if (!root.isDirectory() || root.isSymbolicLink())
            throw fault('PROJECT_INPUT_UNAVAILABLE', 'STEP 来源目录类型异常。');
        const cancelled = () => { if (signal?.aborted)
            throw fault('PROJECT_INPUT_CANCELLED', '来源文件准备已取消，未开始几何导入。'); };
        let input, output, created, proof, targetChanged = false;
        try {
            cancelled();
            this.checkRoot();
            if (!sameIdentity(lease.proof, identity(this.checkedStat(lease.file)))) {
                lease.tampered = true;
                throw fault('PROJECT_INPUT_CHANGED', '上传材料身份已变化，未采用。');
            }
            input = await fsp.open(lease.file, 'r');
            if (!sameIdentity(lease.proof, identity(await input.stat({ bigint: true })))) {
                lease.tampered = true;
                throw fault('PROJECT_INPUT_CHANGED', '上传材料读取身份已变化。');
            }
            output = await fsp.open(target, 'wx+', 0o600);
            created = identity(await output.stat({ bigint: true }));
            const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
            let offset = 0;
            while (offset < lease.bytes) {
                cancelled();
                const read = await input.read(buffer, 0, Math.min(buffer.length, lease.bytes - offset), offset);
                if (!read.bytesRead) {
                    lease.tampered = true;
                    throw fault('PROJECT_INPUT_CHANGED', '上传材料在安装期间截断。');
                }
                digest.update(buffer.subarray(0, read.bytesRead));
                let written = 0;
                while (written < read.bytesRead) {
                    cancelled();
                    const result = await output.write(buffer, written, read.bytesRead - written);
                    if (!result.bytesWritten)
                        throw fault('PROJECT_INPUT_WRITE_FAILED', 'STEP 来源写入未前进。');
                    written += result.bytesWritten;
                }
                offset += read.bytesRead;
            }
            if (digest.digest('hex') !== lease.hash || !sameIdentity(lease.proof, identity(await input.stat({ bigint: true }))) || !sameIdentity(lease.proof, identity(this.checkedStat(lease.file)))) {
                lease.tampered = true;
                throw fault('PROJECT_INPUT_CHANGED', '上传材料内容校验失败，未采用。');
            }
            await output.sync();
            const sealed = identity(await output.stat({ bigint: true })), installedHash = createHash('sha256');
            offset = 0;
            if (sealed.size !== BigInt(lease.bytes)) {
                targetChanged = true;
                throw fault('PROJECT_INPUT_CHANGED', '新 STEP 来源长度已变化。');
            }
            while (offset < lease.bytes) {
                cancelled();
                const read = await output.read(buffer, 0, Math.min(buffer.length, lease.bytes - offset), offset);
                if (!read.bytesRead) {
                    targetChanged = true;
                    throw fault('PROJECT_INPUT_CHANGED', '新 STEP 来源在核验时被截断。');
                }
                installedHash.update(buffer.subarray(0, read.bytesRead));
                offset += read.bytesRead;
            }
            if (installedHash.digest('hex') !== lease.hash || !sameIdentity(sealed, identity(await output.stat({ bigint: true }))) || !sameIdentity(sealed, identity(this.checkedStat(target)))) {
                targetChanged = true;
                throw fault('PROJECT_INPUT_CHANGED', '新 STEP 来源内容或身份不匹配，材料已保留。');
            }
            await output.close();
            output = null;
            await input.close();
            input = null;
            cancelled();
            proof = identity(this.checkedStat(target));
            if (!sameIdentity(sealed, proof) || proof.dev !== created.dev || proof.ino !== created.ino) {
                targetChanged = true;
                throw fault('PROJECT_INPUT_CHANGED', '新 STEP 来源身份已变化。');
            }
            let disposed = false;
            return { bytes: lease.bytes, sha256: lease.hash, verify: async () => { try {
                    await this.verifyFile(target, proof, lease.bytes, lease.hash);
                }
                catch (error) {
                    lease.tampered = true;
                    throw error;
                } }, dispose: async ({ retain = false } = {}) => { if (disposed)
                    return; disposed = true; if (retain)
                    return; try {
                    await this.verifyFile(target, proof, lease.bytes, lease.hash);
                    await fsp.unlink(target);
                }
                catch (error) {
                    lease.tampered = true;
                    this.lastError = error.code || 'PROJECT_INPUT_CLEANUP_FAILED';
                } } };
        }
        catch (error) {
            await output?.close();
            await input?.close();
            if (targetChanged)
                this.lastError = 'PROJECT_INPUT_CHANGED';
            if (created && !targetChanged)
                try {
                    const actual = this.checkedStat(target);
                    if (actual.dev === created.dev && actual.ino === created.ino)
                        await fsp.unlink(target);
                    else
                        this.lastError = 'PROJECT_INPUT_CHANGED';
                }
                catch (cleanup) {
                    if (cleanup.code !== 'ENOENT')
                        this.lastError = cleanup.code || 'PROJECT_INPUT_CLEANUP_FAILED';
                }
            if (error instanceof PendingProjectInputError)
                throw error;
            throw fault('PROJECT_INPUT_WRITE_FAILED', 'STEP 来源未完整准备，未开始几何导入。');
        }
    }
    async verifyFile(file, proof, bytes, expectedHash) {
        let reader;
        try {
            if (!sameIdentity(proof, identity(this.checkedStat(file))))
                throw fault('PROJECT_INPUT_CHANGED', '输入材料清理时身份变化，已保留。');
            reader = await fsp.open(file, 'r');
            if (!sameIdentity(proof, identity(await reader.stat({ bigint: true }))))
                throw fault('PROJECT_INPUT_CHANGED', '输入材料清理时读取身份变化。');
            const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024);
            let position = 0;
            while (position < bytes) {
                const read = await reader.read(chunk, 0, Math.min(chunk.length, bytes - position), position);
                if (!read.bytesRead)
                    throw fault('PROJECT_INPUT_CHANGED', '输入材料清理时内容被截断。');
                digest.update(chunk.subarray(0, read.bytesRead));
                position += read.bytesRead;
            }
            if (digest.digest('hex') !== expectedHash || !sameIdentity(proof, identity(await reader.stat({ bigint: true }))) || !sameIdentity(proof, identity(this.checkedStat(file))))
                throw fault('PROJECT_INPUT_CHANGED', '输入材料内容已变化，已保留。');
        }
        finally {
            await reader?.close();
        }
    }
    async read(lease) {
        this.checkRoot();
        let handle;
        try {
            const stat = this.checkedStat(lease.file);
            if (!sameIdentity(lease.proof, identity(stat)))
                throw fault('PROJECT_INPUT_CHANGED', '等待打开的工程输入已变化，未采用该材料。');
            handle = await fsp.open(lease.file, 'r');
            if (!sameIdentity(lease.proof, identity(await handle.stat({ bigint: true }))))
                throw fault('PROJECT_INPUT_CHANGED', '工程输入读取身份变化。');
            const bytes = Buffer.allocUnsafe(lease.bytes);
            let offset = 0;
            while (offset < bytes.length) {
                const result = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
                if (!result.bytesRead)
                    throw fault('PROJECT_INPUT_CHANGED', '工程输入在读取时被截断。');
                offset += result.bytesRead;
            }
            if (createHash('sha256').update(bytes).digest('hex') !== lease.hash || !sameIdentity(lease.proof, identity(await handle.stat({ bigint: true }))) || !sameIdentity(lease.proof, identity(this.checkedStat(lease.file))))
                throw fault('PROJECT_INPUT_CHANGED', '工程输入校验失败，未打开工程。');
            return bytes;
        }
        catch (error) {
            lease.tampered = true;
            if (error instanceof PendingProjectInputError)
                throw error;
            throw fault('PROJECT_INPUT_UNAVAILABLE', '工程输入无法读取，原材料已保留。');
        }
        finally {
            await handle?.close();
        }
    }
    async release(lease,{retain=false}={}) {
        if (!this.leases.has(lease.name))
            return;
        try {
            this.checkRoot();
            if (lease.tampered || !sameIdentity(lease.proof, identity(this.checkedStat(lease.file))))
                throw fault('PROJECT_INPUT_CHANGED', '工程输入清理时身份变化，材料已保留。');
            await this.verifyFile(lease.file, lease.proof, lease.bytes, lease.hash);
            if(retain)this.orphans.set(lease.name,lease.bytes);else await fsp.unlink(lease.file);
        }
        catch (error) {
            this.lastError = error.code || 'PROJECT_INPUT_CLEANUP_FAILED';
            this.orphans.set(lease.name, lease.bytes);
        }
        finally {
            this.leases.delete(lease.name);
            lease.released();
        }
    }
    async close() {
        this.closed = true;
        const leases = [...this.leases.values()];
        for (const lease of leases)
            if (!lease.proof)
                lease.readable.destroy(fault('SERVICE_STOPPING', '后台停止，工程输入上传已中断；未开始打开工程。'));
        await Promise.all(leases.map(lease => lease.done));
    }
}
