import crypto from 'node:crypto';
import {DISCRETE_SOURCE as P,DISCRETE_SOURCE_CAPABILITY,normalizeDiscreteSourceOptions} from '../shared/discrete-surface-source.mjs';
import {captureMeshSource,assessMeshSource} from '../shared/mesh-source.mjs';
import {assertCapabilityPrecondition} from './worker-capabilities.mjs';
import {assertDiscreteResult} from './discrete-surface-protocol.mjs';

const fault=(code,message)=>Object.assign(Error(message),{code,retryableByModel:false});
const invalid=()=>fault('SURFACE_SOURCE_INVALID','CAD 表面来源、完整几何集合、离散策略或逐三角面归属无法核对；未采用显示网格或部分数据。');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const equalSource=(source,other)=>assessMeshSource(source,{documentId:other?.documentId,bodyMetadata:other?.bodies},other?.documentId).status==='current';
const abort=signal=>{if(signal?.aborted)throw fault('SURFACE_CANCELLED','表面重构已取消；未采用迟到的工程来源或结果。');};
function readableSource(view,documentId){try{const source=captureMeshSource(view,documentId);if(!integer(source.revision,0,Number.MAX_SAFE_INTEGER)||!integer(source.bodies.length,1,P.maxBodies))throw Error();return source;}catch{throw fault('SURFACE_SOURCE_UNAVAILABLE','当前工程没有完整可验证的几何身份和修订，未导出表面来源。');}}

/** Validates a native source DTO, not the authority of an arbitrary caller.
 * CAD authority is established only by captureProjectDiscreteSource below. */
export function validateDiscreteSourceBundle(bundle,expectedSource,requestedOptions){
  if(!keys(bundle,['format','version','basis','fingerprint','source','inventory','input','policy','report'])||bundle.format!=='web-cad-discrete-surface-source'||bundle.version!==P.version||bundle.basis!==P.basis||bundle.fingerprint!==P.fingerprint)throw invalid();
  const {source,inventory,input,policy,report}=bundle,options=normalizeDiscreteSourceOptions(requestedOptions);
  if(!keys(source,['version','documentId','revision','bodies'])||source.version!==1||source.documentId!==expectedSource.documentId||source.revision!==expectedSource.revision||!equalSource(expectedSource,source)||!equalSource(source,expectedSource))throw invalid();
  for(const body of source.bodies)if(!keys(body,['bodyId','kind','bodyIdentity','topologyIdentity','topologyRevision'])||typeof body.bodyId!=='string'||!/^[A-Za-z0-9_.:-]{1,80}$/.test(body.bodyId))throw invalid();
  if(!keys(inventory,['bodies','faces','solids'])||!Array.isArray(inventory.bodies)||inventory.bodies.length!==source.bodies.length||!integer(inventory.bodies.length,1,P.maxBodies)||!Array.isArray(inventory.faces)||!integer(inventory.faces.length,1,P.maxFaces)||!Array.isArray(inventory.solids)||!integer(inventory.solids.length,0,P.maxSolids))throw invalid();
  if(!keys(policy,['version','basis','linearDeflection','angularDeflection','maxTriangles','relative','sourceMeshReused','deflectionEvidence','distanceBoundCertified'])||policy.version!==1||policy.basis!=='occt-private-copy-absolute-deflection-v1'||policy.relative!==false||policy.sourceMeshReused!==false||policy.distanceBoundCertified!==false||policy.deflectionEvidence!=='occt-recorded-parameters-and-estimate-not-certified-distance-v1'||Object.keys(options).some(key=>policy[key]!==options[key]))throw invalid();
  if(!keys(input,['units','points','triangles','sources'])||input.units!=='mm'||!Array.isArray(input.triangles)||!integer(input.triangles.length,1,options.maxTriangles)||!Array.isArray(input.sources)||input.sources.length!==input.triangles.length||!Array.isArray(input.points)||input.points.length!==3*input.triangles.length)throw invalid();
  for(const point of input.points)if(!Array.isArray(point)||point.length!==3||point.some(value=>typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e12))throw invalid();
  for(let i=0;i<input.triangles.length;i++)if(!Array.isArray(input.triangles[i])||input.triangles[i].length!==3||input.triangles[i].some((value,j)=>value!==3*i+j))throw invalid();
  const expectedBodies=new Map(source.bodies.map(body=>[body.bodyId,body])),bodies=new Map();
  let faceCount=0,solidCount=0;
  for(const body of inventory.bodies){
    const expected=expectedBodies.get(body.bodyId);
    if(!keys(body,['bodyId','kind','bodyIdentity','topologyIdentity','topologyRevision','geometryFingerprint','faceCount','solidCount'])||!expected||bodies.has(body.bodyId)||['kind','bodyIdentity','topologyIdentity','topologyRevision'].some(key=>body[key]!==expected[key])||!/^[a-f0-9]{64}$/.test(body.geometryFingerprint||'')||!integer(body.faceCount,1,P.maxFaces)||!integer(body.solidCount,0,P.maxSolids))throw invalid();
    bodies.set(body.bodyId,body);faceCount+=body.faceCount;solidCount+=body.solidCount;
  }
  if(faceCount!==inventory.faces.length||solidCount!==inventory.solids.length)throw invalid();
  const solids=new Map();
  for(const solid of inventory.solids){const body=bodies.get(solid.bodyId);
    if(!keys(solid,['bodyId','solidId','solidIndex'])||!body||!integer(solid.solidIndex,0,body.solidCount-1)||solid.solidId!==`solid-${solid.bodyId}-${solid.solidIndex}`||solids.has(solid.solidId))throw invalid();solids.set(solid.solidId,solid);
  }
  const seenFaces=new Set(),solidUses=new Set();let cursor=0,maxDeflection=0,estimateExceeds=0;
  for(const face of inventory.faces){const body=bodies.get(face.bodyId),key=face.bodyId+'\0'+face.faceId;
    if(!keys(face,['bodyId','faceId','faceIndex','triangleStart','triangleCount','mesherDeflection','meshingParameters','estimateExceedsRequested','uses'])||!body||!integer(face.faceIndex,0,body.faceCount-1)||face.faceId!==`face-${body.topologyRevision}-${face.faceIndex+1}`||seenFaces.has(key)||face.triangleStart!==cursor||!integer(face.triangleCount,1,input.triangles.length)||typeof face.mesherDeflection!=='number'||!Number.isFinite(face.mesherDeflection)||face.mesherDeflection<0||!keys(face.meshingParameters,['linearDeflection','angularDeflection'])||face.meshingParameters.linearDeflection!==options.linearDeflection||face.meshingParameters.angularDeflection!==options.angularDeflection||face.estimateExceedsRequested!==(face.mesherDeflection>options.linearDeflection*(1+1e-10))||!Array.isArray(face.uses)||!integer(face.uses.length,1,64))throw invalid();seenFaces.add(key);maxDeflection=Math.max(maxDeflection,face.mesherDeflection);if(face.estimateExceedsRequested)estimateExceeds++;let faceTriangles=0;
    for(let i=0;i<face.uses.length;i++){const use=face.uses[i],solid=solids.get(use.solidId);
      if(!keys(use,['useIndex','solidId','orientation','triangleStart','triangleCount'])||use.useIndex!==i||use.triangleStart!==cursor||!integer(use.triangleCount,1,input.triangles.length-cursor)||!['forward','reversed','internal','external'].includes(use.orientation)||use.solidId!==''&&(!solid||solid.bodyId!==body.bodyId)||use.solidId===''&&face.uses.length!==1)throw invalid();
      if(solid)solidUses.add(solid.solidId);
      for(let j=0;j<use.triangleCount;j++){const owner=input.sources[cursor+j];if(!keys(owner,use.solidId?['bodyId','faceId','solidId']:['bodyId','faceId'])||owner.bodyId!==body.bodyId||owner.faceId!==face.faceId||(owner.solidId??'')!==use.solidId)throw invalid();}
      cursor+=use.triangleCount;faceTriangles+=use.triangleCount;
    }if(faceTriangles!==face.triangleCount)throw invalid();
  }
  if(cursor!==input.triangles.length||solidUses.size!==solids.size)throw invalid();
  if(!keys(report,['complete','truncated','sourceGeometryUnchanged','bodyCount','faceCount','solidCount','triangleCount','maxMesherDeflection','estimateExceedsRequestedFaceCount','tetrahedralReady','volumeDomainReconstruction'])||report.complete!==true||report.truncated!==false||report.sourceGeometryUnchanged!==true||report.bodyCount!==bodies.size||report.faceCount!==faceCount||report.solidCount!==solidCount||report.triangleCount!==cursor||report.maxMesherDeflection!==maxDeflection||report.estimateExceedsRequestedFaceCount!==estimateExceeds||report.tetrahedralReady!==false||report.volumeDomainReconstruction!=='not-performed')throw invalid();
  if(Buffer.byteLength(JSON.stringify(input))+1024>P.maxInputBytes||Buffer.byteLength(JSON.stringify(bundle))>P.maxBundleBytes)throw fault('SURFACE_SOURCE_LIMIT','完整 CAD 表面来源超出传输额度；未截断输入。');
  return bundle;
}

/** Revalidates a captured DTO on a trusted artifact boundary. A valid DTO by
 * itself is not proof that an arbitrary caller owns the current CAD source. */
export function validateProjectDiscreteSourceSnapshot(snapshot,source,options){
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  if(!keys(source,['version','documentId','revision','bodies'])||source.version!==1||typeof source.documentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(source.documentId)||!integer(source.revision,0,Number.MAX_SAFE_INTEGER)||!Array.isArray(source.bodies)||!integer(source.bodies.length,1,P.maxBodies)||!keys(snapshot,['bundle','source','binding'])||!same(snapshot.source,source))throw invalid();
  validateDiscreteSourceBundle(snapshot.bundle,source,options);const b=snapshot.binding;
  if(!b||typeof b!=='object'||Array.isArray(b)||b.version!==1||b.basis!=='current-cad-private-copy-surface-v1'||!same(b.source,source)||!/^[a-f0-9-]{36}$/.test(b.workerInstance||'')||b.bundleSha256!==hash(snapshot.bundle)||b.inputSha256!==hash(snapshot.bundle.input)||!same(b.approximationPolicy,snapshot.bundle.policy)||b.tetrahedralReady!==false||!b.geometryFingerprints||typeof b.geometryFingerprints!=='object'||Array.isArray(b.geometryFingerprints)||Object.keys(b.geometryFingerprints).length!==snapshot.bundle.inventory.bodies.length||snapshot.bundle.inventory.bodies.some(body=>!Object.hasOwn(b.geometryFingerprints,body.bodyId)||b.geometryFingerprints[body.bodyId]!==body.geometryFingerprint)||b.stateToken!==undefined&&!/^[a-f0-9]{64}$/.test(b.stateToken))throw invalid();
  return snapshot;
}

export async function captureProjectDiscreteSource({documentId,command,serializeDocument,getCapabilities,options,signal,baseRevision}){
  if(typeof documentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(documentId)||[command,serializeDocument,getCapabilities].some(value=>typeof value!=='function'))throw fault('SURFACE_SOURCE_REQUEST_INVALID','表面来源捕获缺少明确工程或可信后台读取边界。');
  const normalized=normalizeDiscreteSourceOptions(options);abort(signal);
  return serializeDocument(documentId,async()=>{
    abort(signal);const before=await command('document.summary',{documentId});if(before?.ok!==true||before.documentId!==documentId)throw fault('SURFACE_SOURCE_UNAVAILABLE','无法读取当前工程，未导出表面来源。');
    if(baseRevision!==undefined&&baseRevision!==before.revision)throw fault('STALE_REVISION','工程已变化，未使用旧修订开始表面重构。');
    const source=readableSource(before,documentId),capabilities=getCapabilities(),precondition={version:1,workerInstance:capabilities?.workerInstance,capability:DISCRETE_SOURCE_CAPABILITY};assertCapabilityPrecondition(precondition,capabilities);
    const response=await command('mesh.discrete.export',{documentId,parameters:normalized,workerCapabilityPrecondition:precondition});abort(signal);
    if(response?.ok!==true)throw fault(response?.code||'SURFACE_EXPORT_FAILED',typeof response?.error==='string'?response.error.slice(0,1024):'当前工程表面导出失败，没有采用替代来源。');
    if(response.protocolVersion!==1||response.documentId!==documentId||response.revision!==source.revision)throw invalid();
    const bundle=validateDiscreteSourceBundle(response.discreteSurface,source,normalized),after=await command('document.summary',{documentId});abort(signal);assertCapabilityPrecondition(precondition,getCapabilities());
    if(after?.ok!==true||after.documentId!==documentId||after.revision!==before.revision||!equalSource(source,readableSource(after,documentId))||before.stateToken!==after.stateToken)throw fault('SURFACE_SOURCE_CHANGED','捕获期间工程或实际内核已变化；未采用混合来源。');
    return {bundle,source,binding:{version:1,basis:'current-cad-private-copy-surface-v1',source,workerInstance:precondition.workerInstance,bundleSha256:hash(bundle),inputSha256:hash(bundle.input),...(typeof before.stateToken==='string'?{stateToken:before.stateToken}:{}),approximationPolicy:{...bundle.policy},geometryFingerprints:Object.fromEntries(bundle.inventory.bodies.map(body=>[body.bodyId,body.geometryFingerprint])),tetrahedralReady:false}};
  },{signal});
}

/** Reconstructs an immutable captured snapshot; does not mutate CAD or expose a
 * mesh for normal rendering/tetrahedral meshing. A later task persists this DTO. */
export async function reconstructProjectSurfaceSnapshot({client,...capture}){
  if(typeof client?.refine!=='function')throw fault('SURFACE_SOURCE_REQUEST_INVALID','缺少受控表面重构客户端，未捕获工程。');
  const snapshot=await captureProjectDiscreteSource(capture);abort(capture.signal);
  const result=await client.refine(snapshot.bundle.input,{signal:capture.signal});abort(capture.signal);
  if(hash(snapshot.bundle)!==snapshot.binding.bundleSha256||hash(snapshot.bundle.input)!==snapshot.binding.inputSha256)throw fault('SURFACE_SOURCE_CHANGED','已捕获的离散来源在重构期间被修改，未绑定结果。');
  assertDiscreteResult(result,snapshot.bundle.input,result.requestId);
  if(result.execution?.basis!=='single-process-exit-confirmed-v1'||result.execution.exitCode!==0||result.execution.automaticReplay!==false||result.processResources?.enforced!==true)throw fault('SURFACE_EXECUTION_UNVERIFIED','表面重构没有完整退出与资源证明，未绑定为工程结果。');
  const current=await capture.serializeDocument(capture.documentId,()=>capture.command('document.summary',{documentId:capture.documentId}));abort(capture.signal);
  const freshness=assessMeshSource(snapshot.source,current,capture.documentId);
  return {ok:true,basis:'cad-source-bound-discrete-surface-v1',sourceBundle:snapshot.bundle,result,projectBinding:snapshot.binding,freshness,sourceCurrent:freshness.status==='current',approximation:{distanceBoundCertified:false,estimateExceedsRequestedFaceCount:snapshot.bundle.report.estimateExceedsRequestedFaceCount},normalMeshAdmitted:false,appliedToCad:false,tetrahedralReady:false};
}
