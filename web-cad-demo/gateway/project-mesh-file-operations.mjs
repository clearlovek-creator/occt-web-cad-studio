import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {MeshJobStore} from './mesh-job-store.mjs';
import {MeshAssetRegistry,assetDigest,assetDirectoryChain,readAssetFile,emptyMeshAssetSnapshot} from './mesh-asset-registry.mjs';
import {captureProjectMeshArchive,combineProjectMeshArchives,materializeProjectMeshArchive,openMaterializedMeshAsset,validateProjectMeshArchive} from './project-mesh-archive.mjs';
import {collectProjectSources,encodeProjectPackage,decodeProjectPackage} from './project-package.mjs';
import {queryMeshQuality} from './mesh-quality-query.mjs';
import {writeDiscreteMeshFiles} from './discrete-mesh-files.mjs';
import {preparationPaths,copyPreparationFile} from './mesh-preparation-files.mjs';
import {assessMeshSource,captureMeshSource} from '../shared/mesh-source.mjs';
import {meshCompletionRecord} from './mesh-completion-record.mjs';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),fail=(message,code='PROJECT_MESH_OPERATION_INVALID')=>{throw Object.assign(Error(message),{code});},DOC=/^[A-Za-z0-9_-]{1,64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function write(file,bytes){const fd=fs.openSync(file,'wx');try{let at=0;while(at<bytes.length){const n=fs.writeSync(fd,bytes,at,Math.min(1024**2,bytes.length-at),null);if(!n)fail('工程资产写入未取得进展。');at+=n;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return {bytes:bytes.length,sha256:hash(bytes)};}
const identity=file=>{const stat=fs.lstatSync(file,{bigint:true});return Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(key=>[key,String(stat[key])]));};
function folder(dataDir,input,kind){if(!DOC.test(input?.documentId)||typeof input.folderName!=='string'||!new RegExp('^'+(kind==='save'?'export-':'')+input.documentId+'-[A-Za-z0-9]{6}$').test(input.folderName))fail('工程资产暂存身份无效。');const root=path.join(dataDir,kind==='save'?'project-transactions':'project-assets',input.folderName);assetDirectoryChain(root);return root;}
function limit(input){for(const key of ['maxUnpackedBytes','maxPackedBytes','storageBytes'])if(!Number.isSafeInteger(input[key])||input[key]<1||input[key]>8*1024**3)fail('工程文件操作缺少有界资源额度。');}
function assetContext(dataDir,ref,{withoutDerived=false}={}){
  const registry=new MeshAssetRegistry(dataDir),location=registry.contextFromWorkerRef(ref),mode=withoutDerived?'absent':ref.state.derivedMode,derivedRoot=mode==='overlay'?path.join(location.stateDirectory,'derived-mesh'):path.join(location.root,'absent-'+ref.assetId),context=openMaterializedMeshAsset(location.root,ref.manifestProof,ref.entryId,{derivedMode:mode,derivedRoot});if(assetDigest(context.job)!==ref.recordHash)fail('恢复资产记录与工程登记不一致。','MESH_ASSET_CHANGED');
  const pointerFile=registry.file(ref.documentId),pointer=readAssetFile(pointerFile,16384),snapshot=registry.snapshot(ref.documentId),indexFile=path.join(location.root,'bindings.json'),index=readAssetFile(indexFile,16*1024**2,ref.indexProof),stateFile=path.join(location.stateDirectory,'state.json');
  if(assetDigest(JSON.parse(pointer.bytes))!==assetDigest(snapshot)||snapshot.setId!==ref.setId)fail('恢复资产登记读取时变化。','MESH_ASSET_CHANGED');
  context.certificate.push({file:pointerFile,identity:pointer.identity},{file:indexFile,identity:index.identity});
  if(fs.existsSync(stateFile)){const state=readAssetFile(stateFile,131072);if(assetDigest(JSON.parse(state.bytes))!==assetDigest(ref.state))fail('恢复资产状态读取时变化。','MESH_ASSET_CHANGED');context.certificate.push({file:stateFile,identity:state.identity});}
  else{if(ref.state.generation!==0)fail('恢复资产状态记录缺失。','MESH_ASSET_CHANGED');context.certificate.push({file:stateFile,absent:true});}
  if(ref.state.recovery?.state==='complete'){context.store.completionFile=path.join(location.stateDirectory,'recovered-completion.json');const completion=readAssetFile(context.store.completionFile,16*1024**2);context.job=context.store.readPersisted(context.job).record;if(context.job.state!=='complete')fail('恢复凭据未证明原结果完成。','MESH_METADATA_COMPLETION_INVALID');context.certificate.push({file:context.store.completionFile,identity:completion.identity});}return {...context,...location};
}
function certificate(context,job){const values=[...context.certificate];if(job.kind==='discrete-tetra'&&fs.existsSync(context.store.derivedDirectory(job)))for(const [key,file]of Object.entries(context.store.derivedPaths(job))){const stat=fs.lstatSync(file,{bigint:true});values.push({file,directory:key==='directory',identity:stat});}return values;}
export function projectMeshFileOperation(dataDir,operation,input,contextOptions={}){
  if(operation==='asset-catalog'){const registry=new MeshAssetRegistry(dataDir),items=registry.loadAll();return {items,retainedPointerStages:registry.retainedPointerStages};}
  if(operation==='project-package-save'){
    limit(input);const directory=folder(dataDir,input,'save'),source=captureMeshSource(input.summary,input.documentId),archives=[],store=new MeshJobStore(dataDir);
    if(input.nativeJobs?.length)archives.push(captureProjectMeshArchive({store,documentId:input.documentId,source,jobs:input.nativeJobs}));
    for(const ref of input.assetRefs||[]){if(ref.documentId!==input.documentId||ref.state.deleted||ref.state.attempts.some(row=>row.state==='working')||ref.state.recovery?.state==='checking')fail('工程网格资产仍在操作中，未保存混合快照。','PROJECT_MESH_ARCHIVE_BUSY');const context=assetContext(dataDir,ref),originSource={...source,documentId:context.job.documentId},archive=captureProjectMeshArchive({store:context.store,documentId:context.job.documentId,source:originSource,jobs:[context.job]});archives.push({archive,assetIds:{[context.job.jobId]:ref.assetId}});}
    const meshArchive=archives.length?combineProjectMeshArchives(source,archives):undefined,geometry=readAssetFile(path.join(directory,'model.xbf'),input.maxUnpackedBytes).bytes,sources=collectProjectSources(input.summary.features||[],dataDir,{maxSourceBytes:input.maxUnpackedBytes}),bytes=encodeProjectPackage({geometry,projectData:input.projectData,sources,meshArchive,documentId:input.documentId,revision:input.summary.revision,name:input.name},{maxUnpackedBytes:input.maxUnpackedBytes});
    if(bytes.length>input.maxPackedBytes||bytes.length>input.storageBytes)fail('工程包超过可重新打开的大小或当前磁盘预留额度。','PROJECT_TOO_LARGE');const proof=write(path.join(directory,'project.cadproj'),bytes);return {proof,meshAssetCount:meshArchive?.assets.length||0,version:meshArchive?3:2};
  }
  if(operation==='project-package-open'){
    limit(input);const directory=folder(dataDir,input,'open'),packed=readAssetFile(path.join(directory,'input.cadproj'),input.maxPackedBytes).bytes,unpacked=decodeProjectPackage(packed,{maxUnpackedBytes:input.maxUnpackedBytes}),checked=unpacked.meshArchive?validateProjectMeshArchive(unpacked.meshArchive):null,expanded=unpacked.geometry.length+unpacked.sources.reduce((sum,row)=>sum+row.bytes.length,0)+(checked?.expandedBytes||0),metadataBytes=checked?Buffer.byteLength(JSON.stringify(checked.manifest))+Buffer.byteLength(JSON.stringify(checked.jobs))+Buffer.byteLength(JSON.stringify(checked.manifest.source))+checked.blobs.size*100+checked.jobs.length*700+4096:4096;
    if(expanded+packed.length+metadataBytes>input.storageBytes)fail('当前磁盘预留不足以暂存完整工程和网格。','PROJECT_IMPORT_STORAGE_ADMISSION');const geometryFile=path.join(directory,'model.xbf'),geometryProof=write(geometryFile,unpacked.geometry),geometryIdentity=identity(geometryFile),sources=unpacked.sources.map((source,i)=>{const name='source-'+i+'-'+hash(source.bytes).slice(0,16)+'.step',file=path.join(directory,name),proof=write(file,source.bytes);return {featureId:source.featureId,fileName:source.fileName,name,proof,identity:identity(file)};});
    let preparedMeshAssets={snapshot:emptyMeshAssetSnapshot(input.documentId),index:{version:1,documentId:input.documentId,setId:null,bindings:[]}};
    if(unpacked.meshArchive){const staged=materializeProjectMeshArchive(unpacked.meshArchive,directory),setId=crypto.randomUUID(),index={version:1,documentId:input.documentId,setId,source:staged.manifest.source,bindings:staged.manifest.assets.map((asset,i)=>({assetId:'mesh-'+crypto.randomUUID(),entryId:asset.assetId,job:staged.jobs[i],hasDerived:staged.summaries[i].hasDerived}))},indexBytes=Buffer.from(JSON.stringify(index));if(indexBytes.length>16*1024**2)fail('工程资产登记索引超过预算。','PROJECT_MESH_ARCHIVE_LIMIT');const indexProof=write(path.join(staged.directory,'bindings.json'),indexBytes);preparedMeshAssets={snapshot:{version:1,documentId:input.documentId,setId,archiveRoot:input.folderName+'/'+path.basename(staged.directory),manifestProof:staged.manifestProof,indexProof},index};}
    return {legacy:unpacked.legacy,packageVersion:unpacked.packageVersion,metadata:unpacked.metadata,propertySchema:unpacked.propertySchema,projectData:unpacked.projectData,sources,geometryProof,geometryIdentity,preparedMeshAssets};
  }
  if(operation.startsWith('asset-')){
    const context=assetContext(dataDir,input.ref),{store,job}=context;
    if(operation==='asset-capture-tetra-recovery')return new MeshJobStore(dataDir).stageOptimizationRecovery(store,job,contextOptions.job,{staging:contextOptions.staging});
    if(operation==='asset-recover-completion'){
      if(job.state!=='failed'||job.errorCode!=='MESH_COMPLETION_UNCOMMITTED'||!job.artifact?.result||input.ref.state.recovery?.state!=='checking')fail('原失败结果或恢复请求已变化。','MESH_COMPLETION_RECOVERY_CONFLICT');
      const previous=store.readPersisted(job),record=store.record({...job,state:'complete',finishedAt:new Date().toISOString(),...(job.kind==='discrete-tetra'?{discreteStage:'complete'}:{})});delete record.error;delete record.errorCode;
      store.readResult(record);
      const file=path.join(context.stateDirectory,'recovered-completion.json');assetDirectoryChain(context.stateDirectory);
      if(fs.existsSync(file)){store.completionFile=file;const existing=store.readPersisted(job);if(existing.record.state!=='complete')fail('已有恢复凭据无效。','MESH_METADATA_COMPLETION_INVALID');return {existing:true};}
      const receipt=meshCompletionRecord(previous.record,record,previous.metadataProof,{recovery:{requestId:input.ref.state.recovery.requestId,failedStateToken:previous.metadataProof.sha256}}),bytes=Buffer.from(JSON.stringify(receipt));if(bytes.length>16*1024**2)fail('恢复完成凭据超过预算。','MESH_ARTIFACT_LIMIT');return {proof:write(file,bytes),existing:false};
    }
    if(operation==='asset-derive'){
      if(job.kind!=='discrete-tetra'||job.state!=='complete'||!UUID.test(input.requestId))fail('恢复网格的派生请求无效。');const directory=path.join(context.stateDirectory,'derive-'+input.requestId+'.tmp'),target=path.join(context.stateDirectory,'derived-mesh');assetDirectoryChain(context.stateDirectory);
      if(fs.existsSync(target)){store.derivedRoot=target;const read=store.readDerivedTetra(job);return {existing:true,proof:read.derivedMeshRegistration};}
      if(fs.existsSync(directory))fail('恢复网格已有同名暂存，未覆盖。');fs.mkdirSync(directory);const materials=store.readTetraMaterials(job),value=writeDiscreteMeshFiles({directory,...materials,jobId:job.jobId});return {existing:false,directoryName:path.basename(directory),identity:fs.lstatSync(directory,{bigint:true}),files:fs.readdirSync(directory).map(name=>({name,identity:fs.lstatSync(path.join(directory,name),{bigint:true})})),manifest:value.manifest,manifestProof:value.manifestProof};
    }
    if(operation==='asset-reuse-prepared'){
      const target=input.targetJob,prepared=store.readPrepared(job);if(target.documentId!==input.ref.documentId||target.state!=='preparing'||assessMeshSource({...job.source,documentId:target.documentId},{bodyMetadata:target.source.bodies},target.documentId).status!=='current')fail('恢复预览与目标工程来源不一致。','MESH_PREPARATION_STALE');const paths=preparationPaths(dataDir,target,{create:true}),manifest={...prepared.manifest,documentId:target.documentId,revision:target.source.revision};copyPreparationFile(prepared.brepPath,paths.source,job.artifact.preparedBrep);write(paths.sourceManifest,Buffer.from(JSON.stringify(manifest)));return {manifest,diagnostics:prepared.result.preparation.diagnostics};
    }
    let result,verification;
    if(operation==='asset-quality'){
      const read=job.kind==='discrete-tetra'?store.readDerivedTetra(job):{...store.readResult(job),index:store.readQuality(job)};if(!read.index)fail('恢复网格缺少完整质量明细。','MESH_QUALITY_UNAVAILABLE');result=queryMeshQuality(read.index,job,input.query||{});verification={...read};delete verification.index;
    }else if(operation==='asset-surface-report'){result=store.readSurfaceReport(job,input.query||{});verification=store.readResult(job);}
    else if(operation==='asset-read'){result=store.readResult(job);verification=result;}
    else fail('不支持的恢复网格操作。');
    return {value:result,verification,certificate:certificate(context,job),originJob:job,outputPath:job.kind==='discrete-tetra'?store.derivedPaths(job).mesh:store.output(job),renderPath:job.kind==='discrete-tetra'?store.derivedPaths(job).render:store.renderOutput(job)};
  }
  fail('未知工程资产操作。');
}
