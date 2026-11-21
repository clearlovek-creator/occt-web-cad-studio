import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { MeshJobStore } from './mesh-job-store.mjs';
import { preparationPaths, readPreparationManifest, stagePreparationFiles } from './mesh-preparation-files.mjs';
import {SURFACE_TASK_KIND} from '../shared/discrete-surface-task.mjs';
import {validateSurfaceTaskResult} from './discrete-surface-task-result.mjs';
import {surfaceArtifactIO} from './surface-artifact-io.mjs';
import {DISCRETE_TETRA_TASK_KIND} from '../shared/discrete-tetra-task.mjs';
import {validateTetraTaskResult,tetraTaskResult,tetraTaskFailure,tetraExecutionInput,tetraMeshInput} from './discrete-tetra-task-result.mjs';
import {assembleCadDiscreteTetraResult} from './cad-discrete-tetra.mjs';
import {tetraTaskCheckpoint} from './discrete-tetra-checkpoint.mjs';
import {validateDiscreteNativePacket} from './discrete-native-validation.mjs';
import path from 'node:path';
import {writeDiscreteMeshFiles} from './discrete-mesh-files.mjs';
import {queryMeshQuality} from './mesh-quality-query.mjs';
const { id, dataDir, operation, job, staging } = workerData;
try {
    const store = new MeshJobStore(dataDir);
    let value,admissionVerification=null;
    if(operation.startsWith('asset-')||operation.startsWith('project-package-')){const {projectMeshFileOperation}=await import('./project-mesh-file-operations.mjs');value=projectMeshFileOperation(dataDir,operation,workerData.result,{job,staging});}
    else if (operation === 'recover-catalog')
        value = store.loadCatalog({limits:workerData.catalogLimits});
    else if (operation === 'read')
        value = store.readResult(job,{admissionMemo:workerData.admissionMemo,onAdmissionVerified:info=>admissionVerification=info.mode});
    else if (operation === 'prepared')
        value = store.readPrepared(job);
    else if (operation === 'source-manifest')
        value = readPreparationManifest(preparationPaths(dataDir, job).sourceManifest, job.source).manifest;
    else if (operation === 'capture-prepared')
        value = stagePreparationFiles({ dataDir, job, staging });
    else if(operation==='capture-surface-source'){
        value={artifact:store.writeSurfaceSource(job,workerData.result,{staging}),identity:fs.lstatSync(staging,{bigint:true})};
    }
    else if(operation==='surface-source')value=store.readSurfaceSource(job);
    else if(operation==='tetra-source')value=store.readTetraSource(job);
    else if(operation==='capture-tetra-recovery')value=store.stageOptimizationRecovery(store,workerData.result.originJob,job,{staging});
    else if(operation==='tetra-checkpoint'){const checkpoint=store.readTetraCheckpoint(job);value={ok:true,protocolVersion:1,requestId:job.jobId,checkpoint:{available:true,normalMeshAdmitted:false,nodeCount:checkpoint.result.baseline.points.length,tetraCount:checkpoint.result.baseline.report.tetraCount,meetsRequestedQuality:checkpoint.result.baseline.quality.meetsRequestedQuality}};}
    else if(operation==='tetra-optimization-command'){
        const snapshot=store.readTetraSource(job),partition=store.readTetraPartition(job),checkpoint=store.readTetraCheckpoint(job);value={input:{generationInput:tetraMeshInput(snapshot,partition),checkpointResult:checkpoint.result},sourceInput:tetraExecutionInput(snapshot)};
        if(Buffer.byteLength(JSON.stringify(value.input))+1024>128*1024**2)throw Object.assign(Error('独立优化命令超过 128 MiB 预算，原检查点保留。'),{code:'MESH_ARTIFACT_LIMIT'});
    }
    else if(operation==='derived-tetra-quality'){
        const read=store.readDerivedTetra(job);value={ok:true,protocolVersion:1,requestId:job.jobId,...queryMeshQuality(read.index,job,workerData.query),derivedMeshRegistration:read.derivedMeshRegistration,derivedCertificate:read.derivedCertificate};
    }
    else if(operation==='derive-tetra-mesh'){
        if(fs.existsSync(path.join(store.directory(job),'derived-mesh')))throw Object.assign(Error('该任务已有派生网格，未覆盖原材料。'),{code:'MESH_DISCRETE_DERIVATION_EXISTS'});
        const materials=store.readTetraMaterials(job);fs.mkdirSync(staging);
        const derived=writeDiscreteMeshFiles({directory:staging,...materials,jobId:job.jobId});
        value={...derived,identity:fs.lstatSync(staging,{bigint:true}),files:['mesh.msh','render.bin','quality.json','result.json','manifest.json'].map(name=>({name,identity:fs.lstatSync(path.join(staging,name),{bigint:true})}))};
    }
    else if(operation==='validate-discrete-native'){
        if(job.kind!==DISCRETE_TETRA_TASK_KIND)throw Object.assign(Error('此任务没有离散体校验权限。'),{code:'MESH_VALIDATION_PROTOCOL_INVALID'});
        value=validateDiscreteNativePacket(workerData.result);
    }
    else if(operation==='tetra-partition-command')value=tetraExecutionInput(store.readTetraSource(job));
    else if(operation==='tetra-command'){
        const snapshot=store.readTetraSource(job),partition=store.readTetraPartition(job);value={input:tetraMeshInput(snapshot,partition),sourceInput:tetraExecutionInput(snapshot)};
        if(Buffer.byteLength(JSON.stringify(value.input))+1024>8*1024**2||Buffer.byteLength(JSON.stringify(value.sourceInput))>8*1024**2)throw Object.assign(Error('离散四面体命令超过有界输入预算，已保留原分区。'),{code:'MESH_ARTIFACT_LIMIT'});
    }
    else if(['capture-tetra-source','capture-tetra-partition','capture-tetra-failure','capture-tetra-checkpoint'].includes(operation)){
        const kind={'capture-tetra-source':'discreteSource','capture-tetra-partition':'partition','capture-tetra-failure':'discreteFailure','capture-tetra-checkpoint':'checkpoint'}[operation],result=kind==='discreteFailure'?tetraTaskFailure(job,store.readTetraSource(job),workerData.result):kind==='checkpoint'?tetraTaskCheckpoint(job,store.readTetraSource(job),store.readTetraPartition(job),workerData.result):workerData.result;value={...store.writeTetraArtifact(job,kind,result,{staging}),identity:fs.lstatSync(staging,{bigint:true})};
    }
    else if(operation==='surface-report')value=store.readSurfaceReport(job,workerData.query);
    else if (operation === 'reuse-prepared') {
        const paths = preparationPaths(dataDir, job);
        readPreparationManifest(paths.manifest, job.source, job.artifact?.preparedManifest);
        const prepared = store.readPrepared(job);
        value = stagePreparationFiles({ dataDir, job, targetJob: workerData.targetJob, staging, reuse: true });
        value.diagnostics = prepared.result.preparation.diagnostics;
    }
    else if (['seal','seal-tetra-output'].includes(operation)) {
        let result=workerData.result;
        if(operation==='seal-tetra-output'){
            const snapshot=store.readTetraSource(job),partition=store.readTetraPartition(job),input=tetraMeshInput(snapshot,partition);
            result=tetraTaskResult(job,assembleCadDiscreteTetraResult(snapshot,partition,workerData.result,{isolated:job.options.optimizationProcess==='checkpoint-v1',...(input.patchPlan?{patchPlan:input.patchPlan}:{})}));
        }
        const artifact=store.writeResult(job,result,{staging});
        const summary=job.kind===SURFACE_TASK_KIND?{surfaceSummary:validateSurfaceTaskResult(result,job,store.readSurfaceSource(job))}:job.kind===DISCRETE_TETRA_TASK_KIND?{discreteTetraSummary:validateTetraTaskResult(result,job,store.readTetraSource(job),store.readTetraPartition(job),job.artifact?.checkpoint?store.readTetraCheckpoint(job):undefined)}:null;
        value = { artifact, result:summary?{ok:true,protocolVersion:1,requestId:job.jobId,...summary}:result, identity: fs.lstatSync(staging, { bigint: true }) };
        if(artifact.quality&&result.mesh?.admission)admissionVerification='full';
    }
    else
        throw Object.assign(Error('不支持的网格材料操作。'), { code: 'MESH_ARTIFACT_REQUEST_INVALID' });
    const replyBytes = Buffer.byteLength(JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? String(value) : value));
    if (replyBytes > (operation==='tetra-optimization-command'?144:64) * 1024 * 1024)
        throw Object.assign(Error('网格材料回复超过当前操作预算，原始材料保留。'), { code: 'MESH_ARTIFACT_LIMIT' });
    parentPort.postMessage({ id, ok: true, value, replyBytes,admissionVerification });
}
catch (error) {
    if(operation.startsWith('asset-')||operation.startsWith('project-package-')){
        const io=['EACCES','EPERM','EBUSY','EIO','ENOSPC','EMFILE','ENFILE','EROFS'].includes(error.code),code=io?'MESH_ASSET_IO':typeof error.code==='string'&&/^(PROJECT|MESH|SURFACE)_[A-Z0-9_]{1,90}$/.test(error.code)?error.code:'MESH_ARTIFACT_INVALID';parentPort.postMessage({id,ok:false,code,error:error.message.slice(0,2048)});
    }else if(operation==='derive-tetra-mesh'){
        const temporaryIO=surfaceArtifactIO(error,job);
        const code=['MESH_DISCRETE_DERIVATION_EXISTS','MESH_DISCRETE_ADMISSION_REJECTED','MESH_DISCRETE_PROJECTION_INVALID','MESH_ARTIFACT_LIMIT'].includes(error.code)?error.code:'MESH_ARTIFACT_INVALID';parentPort.postMessage(temporaryIO?{id,ok:false,...temporaryIO}:{id,ok:false,code,error:error.message.slice(0,1024)});
    }else if(operation==='validate-discrete-native'){
        const code=typeof error.code==='string'&&/^(MESH|SURFACE|VOLUME)_[A-Z_]{1,72}$/.test(error.code)?error.code:'MESH_VALIDATION_PROTOCOL_INVALID';parentPort.postMessage({id,ok:false,code,error:error.message.slice(0,1024)});
    }else{
    const surfaceIO=surfaceArtifactIO(error,job);
    if(surfaceIO){parentPort.postMessage({id,ok:false,...surfaceIO});}
    else {
    const preparationIO = ['source-manifest', 'capture-prepared', 'reuse-prepared'].includes(operation) && ['EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'ENFILE', 'EBUSY', 'EIO', 'EROFS'].includes(error.code);
    parentPort.postMessage({ id, ok: false, code: operation==='recover-catalog'?(error.code?.startsWith('MESH_CATALOG_')?error.code:'MESH_CATALOG_UNAVAILABLE'):preparationIO ? 'MESH_PREPARATION_IO' : ['MESH_ARTIFACT_LIMIT', 'MESH_PREPARATION_IO', 'MESH_SOURCE_MANIFEST_INVALID','MESH_DERIVED_ARTIFACT_INVALID','MESH_ARTIFACT_CHANGED','MESH_QUALITY_QUERY_INVALID'].includes(error.code) ? error.code : 'MESH_ARTIFACT_INVALID', error: operation==='recover-catalog'&&!error.code?.startsWith('MESH_CATALOG_')?'网格历史恢复暂时不可用，原始文件保留。':error.message });
    }
    }
}
finally {
    parentPort.close();
}
