const count=value=>Number.isSafeInteger(value)&&value>=0;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const check=(condition,message)=>{if(!condition)throw new Error('几何诊断报告无效：'+message);};
const vector=value=>Array.isArray(value)&&value.length===3&&value.every(finite);

export function validatePreparation(report,source,preview=null) {
  check(report?.version===1&&['preparing','ready','blocked'].includes(report.status),'版本或状态不合法');
  check(['input','repair','partition','complete'].includes(report.stage)&&(!report.error||typeof report.error==='string')&&(!report.errorCode||typeof report.errorCode==='string'),'阶段或错误信息不合法');
  if(report.status==='ready')check(report.stage==='complete','可用报告尚未完成');
  if(report.status==='blocked')check(typeof report.error==='string'&&report.error.length>0&&typeof report.errorCode==='string'&&report.errorCode.length>0,'失败报告缺少原因');
  check(['strict','conservative','aggressive'].includes(report.repairMode)&&finite(report.tolerance)&&report.tolerance>0&&typeof report.deepCheck==='boolean','检查设置不合法');
  check(Array.isArray(report.bodies)&&Array.isArray(source?.bodies)&&source.bodies.length>0,'缺少 Body 清单或工程来源');
  const bodies=new Map(source?.bodies?.map(body=>[body.bodyId,body])||[]),seen=new Set();
  const inspect=(data,body,isSource)=>{
    check(data&&typeof data.valid==='boolean'&&data.geometryBasis===(isSource?'source':'prepared'),'诊断阶段不合法');
    for(const key of ['faceCount','edgeCount','vertexCount','solidCount','issueCount','errorCount','warningCount','infoCount','selfIntersectionCount','smallEdgeCount','smallFaceCount','sliverFaceCount','openBoundaryEdgeCount','nonManifoldEdgeCount'])check(count(data[key]),key+' 计数不合法');
    check(data.issueCount===data.errorCount+data.warningCount+data.infoCount,'问题数量不一致');
    check(['complete','not-run','failed'].includes(data.selfIntersectionCheck)&&Array.isArray(data.issues)&&data.issues.length<=128&&data.issues.length<=data.issueCount,'检查明细不合法');
    check(typeof data.issuesTruncated==='boolean'&&data.issuesTruncated===(data.issueCount>data.issues.length),'截断标志不一致');
    if(data.bounds!==null)check(vector(data.bounds?.min)&&vector(data.bounds?.max)&&data.bounds.min.every((value,index)=>value<=data.bounds.max[index]),'包围盒不合法');
    for(const key of ['maxTolerance','minimumEdgeLength','minimumFaceArea','signedVolumeSum','smallFeatureThreshold','highToleranceThreshold'])check(data[key]===null||finite(data[key]),key+' 数值不合法');
    for(const key of ['maxTolerance','minimumEdgeLength','minimumFaceArea'])check(data[key]===null||data[key]>=0,key+' 不能为负数');
    check(data.smallFeatureThreshold>0&&data.highToleranceThreshold>0,'检查阈值必须为正数');
    for(const key of ['smallEdgeCount','openBoundaryEdgeCount','nonManifoldEdgeCount'])check(data[key]<=data.edgeCount,key+' 超出边数量');
    for(const key of ['smallFaceCount','sliverFaceCount'])check(data[key]<=data.faceCount,key+' 超出面数量');
    const shown={error:0,warning:0,info:0},unique=new Set();
    for(const issue of data.issues){
      check(typeof issue.code==='string'&&['error','warning','info'].includes(issue.severity)&&['body','face','edge'].includes(issue.kind)&&count(issue.index),'问题条目不合法');
      const key=JSON.stringify([issue.code,issue.kind,issue.index]);check(!unique.has(key),'问题明细重复');unique.add(key);shown[issue.severity]++;
      if(issue.kind!=='body')check(issue.index>0&&issue.index<=data[issue.kind==='face'?'faceCount':'edgeCount'],'问题条目超出拓扑范围');
      if(issue.value!==undefined)check(finite(issue.value),'问题测量值不合法');
      if(issue.bounds!==undefined&&issue.bounds!==null)check(vector(issue.bounds?.min)&&vector(issue.bounds?.max)&&issue.bounds.min.every((value,index)=>value<=issue.bounds.max[index]),'问题包围盒不合法');
      if(issue.target){
        const target=issue.target;check(isSource&&body&&target.bodyId===body.bodyId&&target.bodyIdentity===body.bodyIdentity&&target.topologyIdentity===body.topologyIdentity&&target.topologyRevision===body.topologyRevision,'问题来源身份不一致');
        check(target.kind==='body'||target.kind===issue.kind,'问题选择类型不合法');
        if(target.kind!=='body'){const match=new RegExp(`^${target.kind}-${body.topologyRevision}-([1-9]\\d*)$`).exec(target.topologyId||'');check(match&&Number(match[1])<=data[target.kind==='face'?'faceCount':'edgeCount'],'问题拓扑编号不合法');}
      }
    }
    for(const severity of ['error','warning','info'])check(shown[severity]<=data[severity+'Count'],'问题严重性汇总不一致');
  };
  for(const entry of report.bodies){const body=bodies.get(entry.bodyId);check(body&&!seen.has(entry.bodyId)&&typeof entry.name==='string'&&['solid','sheet','wire','shape'].includes(entry.kind)&&(!body.kind||entry.kind===body.kind),'Body 身份缺失或重复');seen.add(entry.bodyId);inspect(entry.before,body,true);if(entry.afterRepair)inspect(entry.afterRepair,body,false);}
  if(report.afterPartition)inspect(report.afterPartition,null,false);
  if(report.status==='ready')check(seen.size===bodies.size&&report.bodies.every(body=>body.afterRepair?.valid&&body.afterRepair.errorCount===0)&&report.afterPartition?.valid&&report.afterPartition.errorCount===0&&report.afterPartition.solidCount>0,'可用快照缺少完整验证');
  if(preview){
    check(report.status==='ready'&&Array.isArray(preview.positions)&&preview.positions.length>0&&preview.positions.length%9===0&&preview.positions.length<=20000*9&&preview.positions.every(finite),'预览坐标无效');
    check(Array.isArray(preview.normals)&&preview.normals.length===preview.positions.length&&preview.normals.every(finite),'预览法向无效');
    check(Array.isArray(preview.indices)&&preview.indices.length===preview.positions.length/3&&preview.indices.every((index,position)=>index===position),'预览索引无效');
    check(Array.isArray(preview.edges)&&preview.edges.length<=1000&&preview.edges.every(edge=>typeof edge.edgeId==='string'&&Array.isArray(edge.points)&&edge.points.length>=6&&edge.points.length<=36&&edge.points.length%3===0&&edge.points.every(finite)),'预览边线无效');
    check(typeof preview.stats?.truncated==='boolean'&&preview.stats.triangleCount===preview.positions.length/9&&preview.stats.faceCount===report.afterPartition.faceCount&&preview.stats.edgeCount===report.afterPartition.edgeCount,'预览完整性标志缺失');
  }
  return report;
}
export function preparationSummary(report) {
  const before=report.bodies||[];
  return {reportAvailable:true,status:report.status,bodyCount:before.length,errorCount:before.reduce((sum,body)=>sum+(body.afterRepair?.errorCount??body.before?.errorCount??0),0),warningCount:before.reduce((sum,body)=>sum+(body.afterRepair?.warningCount??body.before?.warningCount??0),0),solidCount:report.afterPartition?.solidCount??null,faceCount:report.afterPartition?.faceCount??null};
}
