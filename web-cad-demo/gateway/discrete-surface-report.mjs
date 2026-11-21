const fault=()=>Object.assign(Error('表面来源查询仅接受 Body、面编号和有界分页，不能读取路径或完整几何数组。'),{code:'SURFACE_REPORT_QUERY_INVALID'});
export function normalizeSurfaceReportQuery(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['bodyId','faceId','offset','limit'].includes(key)))throw fault();
  const id=key=>{const v=value[key]??'';if(typeof v!=='string'||v!==''&&!/^[A-Za-z0-9_-]{1,80}$/.test(v))throw fault();return v;};
  const integer=(key,fallback,max)=>{const v=value[key]??fallback;if(typeof v==='string'&&!/^(0|[1-9][0-9]{0,5})$/.test(v)||!['number','string'].includes(typeof v))throw fault();const n=Number(v);if(!Number.isSafeInteger(n)||n<(key==='limit'?1:0)||n>max)throw fault();return n;};
  return {bodyId:id('bodyId'),faceId:id('faceId'),offset:integer('offset',0,10000),limit:integer('limit',10,25)};
}
/** Called only after the complete saved source/result proof has been validated. */
export function surfaceReportPage(snapshot,result,summary,query){
  const q=normalizeSurfaceReportQuery(query),bundle=snapshot.bundle,faces=bundle.inventory.faces,bodies=new Map(bundle.inventory.bodies.map(body=>[body.bodyId,body]));
  const key=source=>source.bodyId+'\0'+source.faceId,counts=new Map(faces.map(face=>[key(face),{outputTriangles:0,sharedOutputTriangles:0}]));
  for(const refs of result.surfaceReconstruction.output.sourceTriangleIds){const owners=new Set(refs.map(index=>key(bundle.input.sources[index])));for(const owner of owners){const count=counts.get(owner);count.outputTriangles++;if(owners.size>1)count.sharedOutputTriangles++;}}
  const selected=faces.filter(face=>(!q.bodyId||face.bodyId===q.bodyId)&&(!q.faceId||face.faceId===q.faceId));
  const rows=selected.slice(q.offset,q.offset+q.limit).map(face=>{const body=bodies.get(face.bodyId);return {source:{bodyId:body.bodyId,cadFaceId:face.faceId,bodyIdentity:body.bodyIdentity,topologyIdentity:body.topologyIdentity,topologyRevision:body.topologyRevision},kind:body.kind,inputTriangles:face.triangleCount,...counts.get(key(face)),solidIds:[...new Set(face.uses.map(use=>use.solidId).filter(Boolean))],useCount:face.uses.length,mesherDeflection:face.mesherDeflection,estimateExceedsRequested:face.estimateExceedsRequested};});
  const page={version:1,basis:'certified-source-face-summary-v1',summary,sourcePolicy:bundle.policy,repairPolicy:result.surfaceReconstruction.output.report?{tolerance:result.surfaceReconstruction.output.report.tolerance,snapGridSize:result.surfaceReconstruction.output.report.snapGridSize,iterations:result.surfaceReconstruction.output.report.iterationLimit}:null,total:selected.length,offset:q.offset,limit:q.limit,faces:rows,normalMeshAdmitted:false,tetrahedralReady:false,appliedToCad:false};
  if(Buffer.byteLength(JSON.stringify(page))>256*1024)throw Object.assign(Error('表面来源页超过 256 KiB，未截断返回。'),{code:'MESH_ARTIFACT_LIMIT'});return page;
}
