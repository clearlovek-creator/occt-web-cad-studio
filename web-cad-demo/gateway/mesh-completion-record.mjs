import crypto from 'node:crypto';
import {parseMeshRecoveryRequest} from '../shared/mesh-completion-recovery.mjs';

const fault=(code,message)=>Object.assign(Error(message),{code});
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex');
const validProof=value=>value&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=16*1024*1024&&/^[a-f0-9]{64}$/.test(value.sha256);
export function meshCompletionRecord(previous,record,previousProof,{recovery}={}){
    if(recovery)recovery=parseMeshRecoveryRequest(recovery);
    const eligible=recovery?previous.state==='failed'&&previous.errorCode==='MESH_COMPLETION_UNCOMMITTED'&&recovery.failedStateToken===previousProof?.sha256:['preparing','running'].includes(previous.state);
    if(!eligible||record.state!=='complete'||previous.documentId!==record.documentId||previous.jobId!==record.jobId||hash(previous.source)!==hash(record.source)||hash(previous.options)!==hash(record.options)||!validProof(previousProof))throw fault('MESH_METADATA_COMPLETION_CONFLICT','网格完成记录与原任务来源或阶段不一致，原文件保留。');
    return {format:'web-cad-mesh-completion',version:1,basis:recovery?'revalidated-retained-artifacts-v1':'validated-artifacts-after-confirmed-worker-exit-v1',previous:previousProof,recordSha256:hash(record),record,...(recovery?{recovery}:{})};
}
export function resolveMeshCompletion(metadata,proof,completion,identity,validateRecord){
    let recovery;
    if(completion?.basis==='revalidated-retained-artifacts-v1')try{recovery=parseMeshRecoveryRequest(completion.recovery);if(recovery.failedStateToken!==completion.previous?.sha256)throw Error();}catch{throw fault('MESH_METADATA_COMPLETION_INVALID','网格恢复凭据身份无效，原文件保留。');}
    if(completion?.format!=='web-cad-mesh-completion'||completion.version!==1||!['validated-artifacts-after-confirmed-worker-exit-v1','revalidated-retained-artifacts-v1'].includes(completion.basis)||!recovery&&completion.recovery!==undefined||!validProof(completion.previous)||typeof completion.recordSha256!=='string'||completion.recordSha256!==hash(completion.record)||completion.record?.state!=='complete'||typeof completion.record.finishedAt!=='string'||!Number.isFinite(Date.parse(completion.record.finishedAt)))throw fault('MESH_METADATA_COMPLETION_INVALID','网格完成凭据无效，原结果保留，未自动恢复或重新剖分。');
    try{validateRecord(completion.record,identity);}catch{throw fault('MESH_METADATA_COMPLETION_INVALID','网格完成凭据的任务或结果身份无效，原文件保留。');}
    const sameIdentity=metadata.documentId===identity.documentId&&metadata.jobId===identity.jobId;
    if(!sameIdentity||hash(metadata.source)!==hash(completion.record.source)||hash(metadata.options)!==hash(completion.record.options))throw fault('MESH_METADATA_COMPLETION_CONFLICT','网格完成凭据与当前任务来源不一致，原文件保留。');
    if(metadata.state==='complete'){
        // A later verified quality-query cache may extend artifact.qualityQuery.
        const primary=value=>{const artifact={...value};delete artifact.qualityQuery;return artifact;};
        if(hash(primary(metadata.artifact))!==hash(primary(completion.record.artifact)))throw fault('MESH_METADATA_COMPLETION_CONFLICT','网格完成凭据与当前结果内容不一致，未选择其中一份。');
        return {...metadata,...(recovery?{completionRecoveryReceipt:recovery}:{})};
    }
    const eligible=recovery?metadata.state==='failed'&&metadata.errorCode==='MESH_COMPLETION_UNCOMMITTED':['preparing','running'].includes(metadata.state);
    if(!eligible||!proof||proof.bytes!==completion.previous.bytes||proof.sha256!==completion.previous.sha256)throw fault('MESH_METADATA_COMPLETION_CONFLICT','网格状态在完成凭据发布后变化，未覆盖现有记录。');
    return {...completion.record,completionReceipt:true,...(recovery?{completionRecoveryReceipt:recovery}:{})};
}
