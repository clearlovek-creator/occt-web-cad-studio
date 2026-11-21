import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MeshJobStore } from './mesh-job-store.mjs';
import { preparationPaths } from './mesh-preparation-files.mjs';
import { MESH_QUERY_TIMEOUTS } from '../shared/mesh-query-timeouts.mjs';
import {backendWorkerOptions} from './backend-runtime.mjs';
import {MeshAdmissionMemo} from './mesh-admission-memo.mjs';
import {meshCatalogLimits} from './mesh-catalog.mjs';
import {normalizeSurfaceReportQuery} from './discrete-surface-report.mjs';
import {surfaceArtifactIO} from './surface-artifact-io.mjs';
import {discreteValidationTransferList} from './discrete-validation-envelope.mjs';
import {normalizeMeshQualityQuery} from './mesh-quality-query.mjs';
const fault = (code, message) => Object.assign(Error(message), { code });
const snapshot = job => Object.fromEntries(['jobId', 'documentId', 'source', 'artifact', 'kind', 'state', 'options', 'processResources', 'preparationSummary','surfaceSummary','materialSourceSha256','discreteStage','discreteTetraSummary','discreteFailureSummary','optimizationRecovery'].filter(key => job[key] !== undefined).map(key => [key, structuredClone(job[key])]));
const identitySame = (a, b) => a && b && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
/** One heavy material operation, bounded queue and coalesced read subscribers.
 * Cancellation never releases a writer or deletes its staging before exit. */
export class MeshArtifactPool {
    constructor({ dataDir, maxQueue = 8, timeoutMs = MESH_QUERY_TIMEOUTS.workerMs, workerFactory = (url, options) => new Worker(url, options),computeGate,admissionMemo=new MeshAdmissionMemo() } = {}) {
        if (!Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 64 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
            throw Error('Invalid mesh artifact queue budget');
        Object.assign(this, { dataDir: path.resolve(dataDir), maxQueue, timeoutMs, workerFactory,computeGate,admissionMemo });
        this.store = new MeshJobStore(dataDir);
        this.queue = [];
        this.active = null;
        this.reads = new Map();
        this.closed = false;
        this.metrics = { requests: 0, workersStarted: 0, coalesced: 0, replyBytes: 0,fullAdmissions:0,reusedAdmissions:0 };
    }
    status() { return { active: Boolean(this.active), queued: this.queue.length, maxActive: 1, maxQueue: this.maxQueue, timeoutMs: this.timeoutMs, closed: this.closed, metrics: { ...this.metrics },admissionMemo:this.admissionMemo.status() }; }
    execute({ operation, job = {jobId:'mesh-catalog'}, result, signal, ownerId = job.jobId, targetJob, catalogLimits,query,beforePublish }) {
        if (!['recover-catalog','read', 'prepared', 'seal', 'source-manifest', 'capture-prepared', 'reuse-prepared','capture-surface-source','surface-source','surface-report','capture-tetra-source','tetra-source','capture-tetra-partition','capture-tetra-failure','capture-tetra-checkpoint','capture-tetra-recovery','tetra-checkpoint','tetra-optimization-command','validate-discrete-native','tetra-partition-command','tetra-command','seal-tetra-output','derive-tetra-mesh','derived-tetra-quality','asset-catalog','project-package-save','project-package-open','asset-read','asset-quality','asset-surface-report','asset-derive','asset-reuse-prepared','asset-recover-completion','asset-capture-tetra-recovery'].includes(operation))
            return Promise.reject(fault('MESH_ARTIFACT_REQUEST_INVALID', '不支持的网格材料操作。'));
        if(beforePublish!==undefined&&(!['derive-tetra-mesh','capture-tetra-checkpoint','seal-tetra-output','capture-tetra-recovery','asset-capture-tetra-recovery'].includes(operation)||typeof beforePublish!=='function'))return Promise.reject(fault('MESH_ARTIFACT_REQUEST_INVALID','此操作不能指定发布钩子。'));
        if(operation==='reuse-prepared'&&(!targetJob||targetJob.documentId!==job.documentId||targetJob.state!=='preparing'||targetJob.jobId===job.jobId))return Promise.reject(fault('MESH_ARTIFACT_REQUEST_INVALID','修复预览复用目标不合法。'));
        if(operation==='derive-tetra-mesh'&&(job.kind!=='discrete-tetra'||job.state!=='complete'||!job.artifact?.result))return Promise.reject(fault('MESH_ARTIFACT_REQUEST_INVALID','只有完整离散体任务可以申请独立网格准入。'));
        if (this.closed)
            return Promise.reject(fault('MESH_ARTIFACT_CLOSED', '网格材料服务正在停止。'));
        if (signal?.aborted)
            return Promise.reject(fault('MESH_ARTIFACT_CANCELLED', '网格材料读取已取消。'));
        if(operation==='validate-discrete-native')try{discreteValidationTransferList(result);}catch(error){return Promise.reject(error);}
        if(operation==='surface-report')try{query=normalizeSurfaceReportQuery(query);}catch(error){return Promise.reject(error);}
        if(operation==='derived-tetra-quality')try{query=normalizeMeshQualityQuery({threshold:job.options?.discreteTetra?.quality?.threshold},job,query);}catch(error){return Promise.reject(error);}
        if(operation.startsWith('asset-')||operation.startsWith('project-package-'))try{result=structuredClone(result);if(Buffer.byteLength(JSON.stringify(result)??'null')>96*1024**2)throw fault('MESH_ARTIFACT_LIMIT','工程资产操作上下文超过有界输入预算。');}catch(error){return Promise.reject(error);}
        const state = snapshot(job), key = ['read','surface-report'].includes(operation) ? crypto.createHash('sha256').update(JSON.stringify([operation,state, this.dataDir,query])).digest('hex') : null;
        if(['seal','seal-tetra-output'].includes(operation))this.admissionMemo.dropJob(job.jobId);
        let entry = key && this.reads.get(key);
        if (entry?.waiters.size >= 32)
            return Promise.reject(fault('MESH_ARTIFACT_BUSY', '同一网格材料的并发观察已达上限。'));
        if (!entry && this.queue.length >= this.maxQueue)
            return Promise.reject(fault('MESH_ARTIFACT_BUSY', '网格材料处理队列已满，请稍后重试。'));
        if (!entry) {
            entry = { id: crypto.randomUUID(), operation, job: state, targetJob:targetJob?snapshot(targetJob):undefined, result,beforePublish,...(['surface-report','derived-tetra-quality'].includes(operation)?{query}:{}), ownerId:targetJob?.jobId||ownerId, key, waiters: new Set(),...(operation==='recover-catalog'?{catalogLimits:meshCatalogLimits(catalogLimits)}:{}) };
            entry.finished = new Promise(resolve => entry.done = resolve);
            entry.timer = setTimeout(() => this.cancel(entry, fault('MESH_ARTIFACT_TIMEOUT', '网格材料处理超时，原始材料保留。')), this.timeoutMs);
            if (key)
                this.reads.set(key, entry);
            this.queue.push(entry);
        }
        else
            this.metrics.coalesced++;
        this.metrics.requests++;
        return new Promise((resolve, reject) => { const waiter = { resolve, reject, signal, ownerId }; waiter.abort = () => { if (entry.waiters.size === 1)
            this.cancel(entry, fault('MESH_ARTIFACT_CANCELLED', '网格材料读取已取消。'));
        else {
            entry.waiters.delete(waiter);
            signal.removeEventListener('abort', waiter.abort);
            reject(fault('MESH_ARTIFACT_CANCELLED', '网格材料读取已取消。'));
        } }; entry.waiters.add(waiter); signal?.addEventListener('abort', waiter.abort, { once: true }); this.pump(); });
    }
    pump() {
        if (this.closed || this.active || !this.queue.length)
            return;
        const entry = this.active = this.queue.shift();
        if(this.computeGate){entry.gateController=new AbortController();void this.computeGate.acquire({kind:'artifact',signal:entry.gateController.signal}).then(lease=>{entry.lease=lease;if(entry.cancelled)this.finish(entry);else this.startWorker(entry);}).catch(error=>{entry.error=error;this.finish(entry);});}else this.startWorker(entry);
    }
    startWorker(entry){
        try {
            entry.staging = ['seal','seal-tetra-output','capture-prepared','reuse-prepared','capture-surface-source','capture-tetra-source','capture-tetra-partition','capture-tetra-failure','capture-tetra-checkpoint'].includes(entry.operation) ? path.join(this.store.directory(entry.targetJob||entry.job), `artifact-${entry.id}.result.tmp`) : undefined;
            if(['derive-tetra-mesh','capture-tetra-recovery','asset-capture-tetra-recovery'].includes(entry.operation))entry.staging=path.join(this.store.directory(entry.job),`artifact-${entry.id}.result.tmp`);
            entry.admissionReceipt=entry.operation==='read'?this.admissionMemo.get(entry.job):null;
            const transferList=entry.operation==='validate-discrete-native'?discreteValidationTransferList(entry.result):[];
            const worker = entry.worker = this.workerFactory(new URL('./mesh-artifact-thread.mjs', import.meta.url), { ...backendWorkerOptions(),workerData: { id: entry.id, dataDir: this.dataDir, operation: entry.operation, job: entry.job, targetJob:entry.targetJob, result: entry.result,query:entry.query, staging: entry.staging,catalogLimits:entry.catalogLimits,...(entry.admissionReceipt?{admissionMemo:{receipt:entry.admissionReceipt,authority:this.admissionMemo.authority()}}:{}) },transferList, resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 32 }, name: 'mesh-artifact' });
            this.metrics.workersStarted++;
            worker.on('message', reply => entry.reply = reply);
            worker.on('error', error => entry.error = fault(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'MESH_ARTIFACT_LIMIT' : 'MESH_ARTIFACT_WORKER_FAILED', '网格材料线程退出：' + error.message));
            worker.once('exit', code => { entry.exitCode = code; this.finish(entry); });
        }
        catch (error) {
            entry.error = error;
            this.finish(entry);
        }
    }
    cleanup(entry) {
        if (!entry.staging)
            return;
        const directory = this.store.directory(entry.targetJob||entry.job);
        if(['capture-prepared','reuse-prepared'].includes(entry.operation))preparationPaths(this.dataDir,entry.targetJob||entry.job);
        if (path.dirname(entry.staging) !== directory || path.basename(entry.staging) !== `artifact-${entry.id}.result.tmp`)
            throw Error('Invalid artifact staging cleanup');
        if (!fs.existsSync(directory))
            return;
        if(['derive-tetra-mesh','capture-tetra-recovery','asset-capture-tetra-recovery'].includes(entry.operation)){
            if(fs.existsSync(entry.staging)){
                const actual=fs.lstatSync(entry.staging),resolved=fs.realpathSync(entry.staging);
                if(!actual.isDirectory()||actual.isSymbolicLink()||resolved!==path.join(fs.realpathSync(directory),path.basename(entry.staging)))throw Error('Invalid discrete mesh staging cleanup');
                fs.rmSync(entry.staging,{recursive:true,force:true});
            }
            return;
        }
        for (const item of fs.readdirSync(directory)) {
            if (item === path.basename(entry.staging) || item.startsWith(path.basename(entry.staging) + '.'))
                fs.rmSync(path.join(directory, item), { force: true });
        }
    }
    async finish(entry) {
        if (entry.finishedOnce)
            return;
        entry.finishedOnce = true;
        if (entry.key && this.reads.get(entry.key) === entry)
            this.reads.delete(entry.key);
        let value, error;
        try {
            if (entry.cancelled)
                throw entry.cancelled;
            if (entry.error)
                throw entry.error;
            const reply = entry.reply;
            if (entry.exitCode !== 0 || !reply || reply.id !== entry.id)
                throw fault('MESH_ARTIFACT_WORKER_FAILED', '网格材料线程未返回完整结果。');
            if (!reply.ok)
                throw fault(reply.code, reply.error);
            value = reply.value;
            if(['capture-tetra-checkpoint','seal-tetra-output','capture-tetra-recovery','asset-capture-tetra-recovery'].includes(entry.operation)){
                await entry.beforePublish?.(value);
                if(entry.cancelled)throw entry.cancelled;
                if(this.closed)throw fault('MESH_ARTIFACT_CLOSED','材料服务正在停止，没有发布迟到结果。');
            }
            if(['capture-tetra-recovery','asset-capture-tetra-recovery'].includes(entry.operation)){
                const target=path.join(this.store.directory(entry.job),'recovery-inputs'),actual=fs.lstatSync(entry.staging,{bigint:true}),names=['discrete-source.json','optimization-checkpoint.json','optimization-origin.json','partition.json'];
                if(!actual.isDirectory()||actual.isSymbolicLink()||!identitySame(actual,value.identity)||fs.existsSync(target)||!Array.isArray(value.files)||value.files.length!==4||JSON.stringify(fs.readdirSync(entry.staging).sort())!==JSON.stringify(names))throw fault('MESH_ARTIFACT_INVALID','恢复输入暂存目录或目标已变化，未覆盖原材料。');
                const seen=new Set();for(const item of value.files){const proof=value.artifact?.[item.kind],stat=fs.lstatSync(path.join(entry.staging,item.name),{bigint:true});if(!names.includes(item.name)||seen.has(item.name)||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||!identitySame(stat,item.identity)||proof?.bytes!==item.proof?.bytes||proof?.sha256!==item.proof?.sha256||stat.size!==BigInt(proof.bytes))throw fault('MESH_ARTIFACT_INVALID','恢复文件发布前凭据或身份变化。');seen.add(item.name);}
                fs.renameSync(entry.staging,target);delete value.identity;delete value.files;
            }
            if(entry.operation==='derive-tetra-mesh'){
                await entry.beforePublish?.(value);
                if(entry.cancelled)throw entry.cancelled;
                if(this.closed)throw fault('MESH_ARTIFACT_CLOSED','材料服务正在停止，未发布派生网格。');
                const directory=this.store.directory(entry.job),target=path.join(directory,'derived-mesh'),actual=fs.lstatSync(entry.staging,{bigint:true}),names=['manifest.json','mesh.msh','quality.json','render.bin','result.json'];
                if(!actual.isDirectory()||actual.isSymbolicLink()||!identitySame(actual,value.identity)||fs.existsSync(target)||!Array.isArray(value.files)||value.files.length!==5||JSON.stringify(fs.readdirSync(entry.staging).sort())!==JSON.stringify(names))throw fault('MESH_ARTIFACT_INVALID','离散网格暂存目录或发布位置发生变化，未覆盖原结果。');
                const expected={'manifest.json':value.manifestProof,'mesh.msh':value.manifest?.files?.mesh,'quality.json':value.manifest?.files?.quality,'render.bin':value.manifest?.files?.render,'result.json':value.manifest?.files?.result},seen=new Set();
                if(value.manifest?.jobId!==entry.job.jobId||value.manifest?.normalMeshAdmitted!==true||value.manifest?.defaultVisible!==false||value.manifest?.admission?.usable!==true)throw fault('MESH_ARTIFACT_INVALID','离散网格发布缺少独立准入证明。');
                for(const item of value.files){
                    if(!names.includes(item.name)||seen.has(item.name))throw fault('MESH_ARTIFACT_INVALID','离散网格文件清单重复或无效。');seen.add(item.name);
                    const current=fs.lstatSync(path.join(entry.staging,item.name),{bigint:true}),proof=expected[item.name];
                    if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||!identitySame(current,item.identity)||!Number.isSafeInteger(proof?.bytes)||proof.bytes<1||current.size!==BigInt(proof.bytes)||!/^[a-f0-9]{64}$/.test(proof.sha256||''))throw fault('MESH_ARTIFACT_INVALID','离散网格文件发布前身份或长度已改变。');
                }
                fs.renameSync(entry.staging,target);delete value.identity;delete value.files;
            }
            if (['seal','seal-tetra-output'].includes(entry.operation)) {
                const actual = fs.lstatSync(entry.staging, { bigint: true });
                if(entry.job.kind==='discrete-tetra'&&fs.existsSync(path.join(this.store.directory(entry.job),'result.json')))throw fault('MESH_ARTIFACT_INVALID','离散体结果已经发布，未覆盖原始材料。');
                if (!actual.isFile() || actual.isSymbolicLink() || !identitySame(actual, value.identity))
                    throw fault('MESH_ARTIFACT_INVALID', '网格暂存结果发布前发生变化。');
                fs.renameSync(entry.staging, path.join(this.store.directory(entry.job), 'result.json'));
                delete value.identity;
            }
            if(entry.operation==='capture-surface-source'){
                const actual=fs.lstatSync(entry.staging,{bigint:true}),target=this.store.surfaceSource(entry.job);
                if(!actual.isFile()||actual.isSymbolicLink()||actual.nlink!==1n||!identitySame(actual,value.identity)||fs.existsSync(target))throw fault('MESH_ARTIFACT_INVALID','表面来源发布位置或暂存身份已改变，未覆盖原文件。');
                fs.renameSync(entry.staging,target);delete value.identity;
            }
            if(['capture-tetra-source','capture-tetra-partition','capture-tetra-failure','capture-tetra-checkpoint'].includes(entry.operation)){
                const kind={'capture-tetra-source':'discreteSource','capture-tetra-partition':'partition','capture-tetra-failure':'discreteFailure','capture-tetra-checkpoint':'checkpoint'}[entry.operation],actual=fs.lstatSync(entry.staging,{bigint:true}),target=this.store.tetraFile(entry.job,kind);
                if(!actual.isFile()||actual.isSymbolicLink()||actual.nlink!==1n||!identitySame(actual,value.identity)||fs.existsSync(target))throw fault('MESH_ARTIFACT_INVALID','离散体材料发布位置或暂存身份变化，未覆盖原文件。');
                fs.renameSync(entry.staging,target);delete value.identity;
            }
            if(['capture-prepared','reuse-prepared'].includes(entry.operation)){
                const paths=preparationPaths(this.dataDir,entry.targetJob||entry.job),targets=entry.operation==='capture-prepared'?[paths.brep,paths.manifest]:[paths.source,paths.sourceManifest];
                if(!Array.isArray(value.files)||value.files.length!==2||value.files[0].suffix!=='.brep'||value.files[1].suffix!=='.manifest')throw fault('MESH_ARTIFACT_INVALID','修复快照缺少完整发布凭据。');
                for(const file of value.files){const actual=fs.lstatSync(entry.staging+file.suffix,{bigint:true});if(!actual.isFile()||actual.isSymbolicLink()||actual.nlink!==1n||!identitySame(actual,file.identity))throw fault('MESH_ARTIFACT_INVALID','修复快照暂存文件发布前发生变化。');}
                for(const target of targets)if(fs.existsSync(target))throw fault('MESH_PREPARATION_IO','修复快照目标已存在，未覆盖已有文件。');
                // Both files remain uncommitted until the task metadata is saved.
                for(let index=0;index<targets.length;index++)fs.renameSync(entry.staging+value.files[index].suffix,targets[index]);
                delete value.files;
            }
            this.metrics.replyBytes += reply.replyBytes || 0;
            if(reply.admissionVerification==='receipt'){
                if(!entry.admissionReceipt||entry.operation!=='read')throw fault('MESH_ARTIFACT_INVALID','网格线程声称复用未经签发的验收。');
                this.metrics.reusedAdmissions++;
            }else if(reply.admissionVerification==='full'){
                this.metrics.fullAdmissions++;
                const verifiedJob=entry.operation==='seal'?{...entry.job,artifact:value.artifact}:entry.job;
                this.admissionMemo.put(verifiedJob,entry.operation==='seal'?value.result?.mesh?.admission:value.mesh?.admission);
            }
        }
        catch (reason) {
            const surfaceIO=surfaceArtifactIO(reason,entry.job);error=surfaceIO?fault(surfaceIO.code,surfaceIO.error):reason;
            if(reason.code==='MESH_ARTIFACT_INVALID')this.admissionMemo.dropJob(entry.job.jobId);
        }
        finally {
            clearTimeout(entry.timer);
            try {
                this.cleanup(entry);
            }
            catch (reason) {
                error ||= reason;
            }
        }
        for (const waiter of entry.waiters) {
            waiter.signal?.removeEventListener('abort', waiter.abort);
            if (error)
                waiter.reject(error);
            else
                waiter.resolve(value);
        }
        entry.waiters.clear();
        entry.lease?.release();
        entry.done();
        if (this.active === entry)
            this.active = null;
        this.pump();
    }
    cancel(entry, error) { if (entry.cancelled)
        return; entry.cancelled = error; if (entry.key && this.reads.get(entry.key) === entry)
        this.reads.delete(entry.key); if (this.active === entry) {
        entry.gateController?.abort();
        void entry.worker?.terminate().catch(() => { });
    }
    else {
        this.queue = this.queue.filter(item => item !== entry);
        this.finish(entry);
    } }
    async cancelJob(jobId) { this.admissionMemo.dropJob(jobId);const entries = [this.active, ...this.queue].filter(entry => entry && (entry.job.jobId === jobId || entry.ownerId === jobId)); for (const entry of entries)
        this.cancel(entry, fault('MESH_ARTIFACT_CANCELLED', '网格任务已结束或删除，材料操作已取消。')); await Promise.all(entries.map(entry => entry.finished)); }
    close() { if (this.closing)
        return this.closing; this.closed = true;this.admissionMemo.clear(); const entries = [this.active, ...this.queue].filter(Boolean); for (const entry of entries)
        this.cancel(entry, fault('MESH_ARTIFACT_CLOSED', '网格材料服务正在停止。')); this.closing = Promise.all(entries.map(entry => entry.finished)); return this.closing; }
}
