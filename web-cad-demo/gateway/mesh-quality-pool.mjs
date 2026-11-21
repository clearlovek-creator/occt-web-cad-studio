import { Worker } from 'node:worker_threads';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeQualityStagingAsync } from './mesh-quality-pages.mjs';
import { normalizeMeshQualityQuery } from './mesh-quality-query.mjs';
import { MESH_QUERY_TIMEOUTS } from '../shared/mesh-query-timeouts.mjs';
import {backendWorkerOptions} from './backend-runtime.mjs';
const failure = (code, message) => Object.assign(new Error(message), { code });
/** One owned heavy query at a time; bounded queue, explicit abort/deadline and
 * an observed worker exit before another writer can touch the same cache. */
export class MeshQualityQueryPool {
    constructor({ maxQueue = 8, timeoutMs = MESH_QUERY_TIMEOUTS.workerMs, workerFactory = (url, options) => new Worker(url, options), computeGate, cachePolicy } = {}) {
        if (!Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 64 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
            throw failure('MESH_QUALITY_QUERY_CONFIG', '质量查询队列或截止设置不合法。');
        Object.assign(this, { maxQueue, timeoutMs, workerFactory, computeGate, cachePolicy });
        this.queue = [];
        this.active = null;
        this.closed = false;
        this.metrics = { requests: 0, workersStarted: 0, builds: 0, parsedSourceBytes: 0, pagesRead: 0, pageBytesRead: 0, cacheEvictions: 0, cacheFreedBytes: 0 };
    }
    status() { return { active: Boolean(this.active), queued: this.queue.length, closed: this.closed, maxActive: 1, maxQueue: this.maxQueue, timeoutMs: this.timeoutMs, lastError: this.lastError || null, lastBuild: this.lastBuild || null, cacheBudget: this.cachePolicy ? { maxBytes: this.cachePolicy.maxBytes, maxJobBytes: this.cachePolicy.maxJobBytes, maxJobs: this.cachePolicy.maxJobs, maxFiles: this.cachePolicy.maxFiles, scanBytes: this.cachePolicy.scanBytes } : null, cacheCapacity: this.cacheCapacity || null, metrics: { ...this.metrics } }; }
    query({ file, job, input = {}, signal, onPrepared }) {
        try {
            normalizeMeshQualityQuery({ threshold: .2 }, job, input);
        }
        catch (error) {
            return Promise.reject(error);
        }
        if (this.closed)
            return Promise.reject(failure('MESH_QUALITY_QUERY_CLOSED', '网格质量查询服务正在停止。'));
        if (signal?.aborted)
            return Promise.reject(failure('MESH_QUALITY_QUERY_CANCELLED', '质量查询已取消。'));
        if (this.queue.length >= this.maxQueue)
            return Promise.reject(failure('MESH_QUALITY_QUERY_BUSY', '质量查询队列已满，请稍后重试。'));
        return new Promise((resolve, reject) => {
            const entry = { file: path.resolve(file), job: { jobId: job.jobId, source: structuredClone(job.source), artifact: structuredClone(job.artifact) }, input: structuredClone(input), signal, onPrepared, resolve, reject };
            entry.finished = new Promise(done => entry.done = done);
            entry.abort = () => this.cancel(entry, failure('MESH_QUALITY_QUERY_CANCELLED', '质量查询已取消，未修改几何或原始网格。'));
            entry.timer = setTimeout(() => this.cancel(entry, failure('MESH_QUALITY_QUERY_TIMEOUT', '质量查询超时，已停止本次只读查询；原始网格保留。')), this.timeoutMs);
            signal?.addEventListener('abort', entry.abort, { once: true });
            this.queue.push(entry);
            this.metrics.requests++;
            this.pump();
        });
    }
    pump() {
        if (this.closed || this.active || !this.queue.length)
            return;
        const entry = this.queue.shift();
        this.active = entry;
        entry.staging = path.join(path.dirname(entry.file), 'quality-pages-' + crypto.randomUUID() + '.tmp');
        if (this.computeGate) {
            entry.gateController = new AbortController();
            void this.computeGate.acquire({ kind: 'quality', signal: entry.gateController.signal }).then(lease => { entry.lease = lease; if (entry.cancelled)
                void this.finish(entry);
            else
                this.startWorker(entry); }).catch(error => { entry.error = error; void this.finish(entry); });
        }
        else
            this.startWorker(entry);
    }
    startWorker(entry) {
        try {
            const worker = this.workerFactory(new URL('./mesh-quality-thread.mjs', import.meta.url), { ...backendWorkerOptions(),workerData: { file: entry.file, job: entry.job, input: entry.input, staging: entry.staging, cachePolicy: this.cachePolicy }, resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 32 }, name: 'mesh-quality-query' });
            entry.worker = worker;
            this.metrics.workersStarted++;
            entry.exited = new Promise(resolve => worker.once('exit', code => { entry.exitCode = code; resolve(); }));
            worker.on('message', reply => entry.reply = reply);
            worker.on('error', error => entry.error = failure(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'MESH_QUALITY_QUERY_LIMIT' : 'MESH_QUALITY_QUERY_FAILED', '质量查询线程退出：' + error.message));
            void entry.exited.then(() => this.finish(entry));
        }
        catch (error) {
            entry.error = error;
            void this.finish(entry);
        }
    }
    async finish(entry) {
        if (entry.finishedOnce)
            return;
        entry.finishedOnce = true;
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener('abort', entry.abort);
        try {
            await removeQualityStagingAsync(entry.file, entry.staging);
            if (entry.cancelled)
                throw entry.cancelled;
            if (entry.error)
                throw entry.error;
            if (entry.exitCode !== 0 || !entry.reply)
                throw failure('MESH_QUALITY_QUERY_FAILED', '质量查询未返回完整结果。');
            if (!entry.reply.ok)
                throw failure(entry.reply.code, entry.reply.error);
            const { proof, metrics, result } = entry.reply;
            if (proof)
                await entry.onPrepared?.(proof);
            if (metrics) {
                if (metrics.built && metrics.sort) {
                    const keys = ['initialRuns', 'mergePasses', 'maxBatchBytes', 'maxBatchRecords', 'maxOpenRuns', 'diskPeakBytes', 'diskWrittenBytes', 'maxPageBufferBytes', 'pageBufferBytes'];
                    this.lastBuild = { at: new Date().toISOString(), mode: 'external-sort-v1', sourcePasses: metrics.sourcePasses, coordinateBytes: metrics.coordinateBytes, ...Object.fromEntries(keys.filter(key => Number.isSafeInteger(metrics.sort[key]) && metrics.sort[key] >= 0).map(key => [key, metrics.sort[key]])) };
                }
                if (metrics.cacheCapacity) {
                    this.cacheCapacity = metrics.cacheCapacity;
                    this.metrics.cacheEvictions += metrics.cacheCapacity.evicted || 0;
                    this.metrics.cacheFreedBytes += metrics.cacheCapacity.freedBytes || 0;
                }
                this.metrics.builds += metrics.built ? 1 : 0;
                for (const key of ['parsedSourceBytes', 'pagesRead', 'pageBytesRead'])
                    this.metrics[key] += metrics[key] || 0;
            }
            if (entry.cancelled)
                throw entry.cancelled;
            entry.resolve(result);
            this.lastError = null;
        }
        catch (error) {
            this.lastError = { code: error.code || 'MESH_QUALITY_QUERY_FAILED', at: new Date().toISOString() };
            entry.reject(error);
        }
        finally {
            entry.lease?.release();
            entry.done();
            if (this.active === entry)
                this.active = null;
            this.pump();
        }
    }
    cancel(entry, error) {
        if (entry.cancelled)
            return;
        entry.cancelled = error;
        if (this.active === entry) {
            entry.gateController?.abort();
            if (entry.worker)
                void entry.worker.terminate().catch(() => { });
            return;
        }
        this.queue = this.queue.filter(value => value !== entry);
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener('abort', entry.abort);
        entry.reject(error);
        entry.done();
    }
    async cancelJob(jobId) {
        const entries = [this.active, ...this.queue].filter(entry => entry?.job.jobId === jobId);
        for (const entry of entries)
            this.cancel(entry, failure('MESH_QUALITY_QUERY_CANCELLED', '网格任务已移除，质量查询已取消。'));
        await Promise.all(entries.map(entry => entry.finished));
    }
    async close() {
        if (this.closing)
            return this.closing;
        this.closed = true;
        const active = this.active;
        for (const entry of [...this.queue, active].filter(Boolean))
            this.cancel(entry, failure('MESH_QUALITY_QUERY_CLOSED', '质量查询服务已停止。'));
        this.closing = active?.finished || Promise.resolve();
        return this.closing;
    }
}
