import path from 'node:path';
import {createHash} from 'node:crypto';
import {managedStepDestination,STEP_SOURCE_ALGORITHM,verifyStepSource} from './step-source-integrity.mjs';
import {sourceArtifactStamp} from './source-checkpoint-catalog.mjs';

export class SourceRestoreProofError extends Error{constructor(code,message){super(message);this.name='SourceRestoreProofError';this.code=code;}}
const fault=(code,message)=>new SourceRestoreProofError(code,message);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
const checked=signal=>{if(signal?.aborted)throw fault('SOURCE_RESTORE_CANCELLED','来源恢复校验已停止，原文件未改变。');};

/** Full disk-only dependency proof, not a replay of CAD modeling history.
 * A retained snapshot may declare dependencies but cannot by itself certify
 * original bytes without a manifest/quarantine checksum anchor. */
export class SourceRestoreProof {
  constructor({dataDir,catalog,inspector,activeRegistry=new Set(),maxReferences=100000,maxReferenceBytes=16*1024*1024}={}){
    Object.assign(this,{dataDir:path.resolve(dataDir),catalog,inspector,activeRegistry,maxReferences,maxReferenceBytes});
  }
  async validate(target,candidate,{signal,onProgress=()=>{}}={}){
    target=managedStepDestination(target,this.dataDir);
    if(candidate?.algorithm!==STEP_SOURCE_ALGORITHM||![candidate.fingerprint,candidate.sha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))||!Number.isSafeInteger(candidate.size)||candidate.size<1)throw fault('SOURCE_RESTORE_CANDIDATE_INVALID','候选来源缺少有效的完整内容证明。');
    checked(signal);
    if(this.activeRegistry.size>=2)throw fault('SOURCE_AUDIT_BUSY','来源检查正在执行，请稍后重新校验已上传的候选文件。');
    const token={};this.activeRegistry.add(token);let uncertainExit;
    try{
      const plan=await this.catalog.storage({signal,onProgress,includeRestorations:false});
      if(plan.issues.length||plan.hasUnsnapshottedGeometry)throw fault('SOURCE_RESTORE_COVERAGE_INCOMPLETE','存在无法核对的清单或恢复材料，不能确认全部来源引用，未允许覆盖。');
      const groups=new Map();
      for(const checkpoint of plan.checkpoints){const key=identity(checkpoint.file),group=groups.get(key)||[];group.push(checkpoint);groups.set(key,group);}
      const references=[];let count=0,referenceBytes=0,certified=false,completed=0;
      for(const group of groups.values()){
        checked(signal);
        const checksums=[...new Set(group.map(item=>item.sha256).filter(Boolean))];
        if(checksums.length>1)throw fault('SOURCE_RESTORE_CHECKPOINT_CONFLICT','同一检查点存在互相冲突的证明，不能据此恢复来源。');
        const snapshot=await this.inspector.inspect(group[0].file,{expectedSha256:checksums[0],signal});
        if(!snapshot.metadataComplete)throw fault('SOURCE_RESTORE_COVERAGE_INCOMPLETE','某个保留检查点的来源元数据不完整，未允许覆盖。');
        for(const source of snapshot.sources){
          if(++count>this.maxReferences)throw fault('SOURCE_RESTORE_LIMIT','来源引用数量超出恢复校验预算，未截取部分引用冒充完整。');
          // Unknown/external aliases cannot be silently ignored in a global
          // replacement proof. In particular, private backups are not inputs.
          let sourcePath;try{sourcePath=managedStepDestination(source.sourcePath,this.dataDir);}catch{throw fault('SOURCE_RESTORE_COVERAGE_INCOMPLETE','保留检查点含非受管或不明确的来源路径，无法排除共享引用。');}
          referenceBytes+=Buffer.byteLength(JSON.stringify(source))+Buffer.byteLength(sourcePath);
          if(referenceBytes>this.maxReferenceBytes)throw fault('SOURCE_RESTORE_LIMIT','来源引用数据超出恢复校验预算。');
          if(identity(sourcePath)!==identity(target))continue;
          if(sourcePath!==target)throw fault('SOURCE_RESTORE_PATH_AMBIGUOUS','来源引用存在大小写路径别名，尚不能排除区分大小写目录中的不同文件，未执行共享路径恢复。');
          let verified;try{verified=verifyStepSource(source,candidate);}catch(error){
            if(error.code==='PROJECT_SOURCE_CHANGED')throw fault('SOURCE_RESTORE_CONFLICT','候选文件与某个当前或保留引用的原始指纹不同，不能覆盖共享来源。');
            throw fault('SOURCE_RESTORE_PROOF_MISSING','某个来源引用缺少可靠的原始内容证明，未允许覆盖。');
          }
          if(verified!=='verified')throw fault('SOURCE_RESTORE_PROOF_MISSING','旧来源引用没有原始内容指纹，不能用新文件补造证明。');
          certified ||= Boolean(checksums[0]);
          for(const checkpoint of group){
            const reference={documentId:checkpoint.documentId||null,scope:checkpoint.scope,checkpoint:checkpoint.name,snapshotSha256:snapshot.snapshotSha256,featureId:source.featureId,sourcePath,sourceFingerprint:source.sourceFingerprint,sourceFingerprintAlgorithm:source.sourceFingerprintAlgorithm,decompositionVersion:source.decompositionVersion??null,certified:Boolean(checkpoint.sha256)};
            referenceBytes+=Buffer.byteLength(JSON.stringify(reference));
            if(references.length>=this.maxReferences||referenceBytes>this.maxReferenceBytes)throw fault('SOURCE_RESTORE_LIMIT','完整来源引用证明超出恢复预算。');
            references.push(reference);
          }
        }
        onProgress({checkpoints:++completed,total:groups.size,references:references.length});
      }
      checked(signal);
      for(const [file,stamp] of plan.metadataWatches)if(sourceArtifactStamp(file)!==stamp)throw fault('SOURCE_RESTORE_STALE','清单或目录在校验期间改变，请重新校验候选来源。');
      if(!references.length)throw fault('SOURCE_RESTORE_UNREFERENCED','没有找到该来源的可验证建模引用；不能把任意上传文件写入来源目录。');
      if(!certified)throw fault('SOURCE_RESTORE_NO_ANCHOR','仅发现没有检查点内容证明的保留引用，不能据此认证原始来源。');
      references.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
      const projects=[...new Set(references.map(item=>item.documentId).filter(Boolean))].sort();
      return {version:1,target,signature:digest(references),referenceCount:references.length,projects,references,candidate:{size:candidate.size,sha256:candidate.sha256,fingerprint:candidate.fingerprint,algorithm:candidate.algorithm}};
    }catch(error){uncertainExit=error.exitObserved;throw error;}
    finally{if(uncertainExit)void uncertainExit.finally(()=>this.activeRegistry.delete(token)).catch(()=>{});else this.activeRegistry.delete(token);}
  }
}
