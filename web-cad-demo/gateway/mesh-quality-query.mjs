import {qualityCellState} from '../shared/mesh-admission.mjs';
import {addQualityValue} from '../shared/mesh-statistics.mjs';
export class MeshQualityQueryError extends Error {constructor(message){super(message);this.code="MESH_QUALITY_QUERY_INVALID";}}
const finiteOrNull=value=>value===null||typeof value==="number"&&Number.isFinite(value);
export function validateQualityHeader(index,job){
  if(index?.version!==1||index.requestId!==job.jobId||index.qualityName!=="minSICN")throw new Error("网格质量索引身份或结构不合法。");
  if(typeof index.threshold!=="number"||!Number.isFinite(index.threshold)||index.threshold<0||index.threshold>1)throw new Error("网格质量索引阈值不合法。");
}
export function createQualityCellValidator(job,positionCount){
  const ids=new Set(),owners=new Set(job.source.bodies.map(body=>body.bodyId));
  return cell=>{
    if(!cell||typeof cell!=="object"||Array.isArray(cell)||typeof cell.elementId!=="string"||!/^[1-9][0-9]*$/.test(cell.elementId)||ids.has(cell.elementId))throw new Error("网格单元身份重复或不合法。");
    ids.add(cell.elementId);
    if(!Number.isInteger(cell.volumeTag)||cell.volumeTag<=0||!Number.isInteger(cell.elementType)||!Number.isInteger(cell.order)||cell.order<1
      ||!Array.isArray(cell.corners)||cell.corners.length!==4||!cell.corners.every(n=>Number.isSafeInteger(n)&&n>=0&&n<positionCount/3)
      ||!finiteOrNull(cell.quality)||!finiteOrNull(cell.minJacobian)||!finiteOrNull(cell.maxJacobian))throw new Error("网格单元连接或质量数据不合法。");
    if(!Array.isArray(cell.bodyIds)||!cell.bodyIds.length||new Set(cell.bodyIds).size!==cell.bodyIds.length||cell.bodyIds.some(id=>!owners.has(id)))throw new Error("网格问题单元缺少明确的 Body 归属。");
    return cell;
  };
}
export function validateQualityIndex(index,job) {
  validateQualityHeader(index,job);
  if(!Array.isArray(index.positions)||index.positions.length%3||!Array.isArray(index.cells))throw new Error("网格质量索引身份或结构不合法。");
  if(!index.positions.every(finiteOrNull))throw new Error("网格质量坐标不合法。");
  const validate=createQualityCellValidator(job,index.positions.length);for(const cell of index.cells)validate(cell);
  return index;
}
function bounded(value,fallback,min,max,name) {const number=value===undefined?fallback:Number(value);if(value===""||!Number.isFinite(number)||number<min||number>max)throw new MeshQualityQueryError(name+"不合法。");return number;}

export function normalizeMeshQualityQuery(index,job,input={}) {
  if(Object.keys(input).some(key=>!["threshold","offset","limit","issue","bodyId"].includes(key)))throw new MeshQualityQueryError("质量查询包含不支持的参数。");
  const threshold=bounded(input.threshold,index.threshold,0,1,"质量阈值");
  const offset=bounded(input.offset,0,0,Number.MAX_SAFE_INTEGER,"分页起点"),limit=bounded(input.limit,20,1,100,"分页数量");
  if(!Number.isInteger(offset)||!Number.isInteger(limit))throw new MeshQualityQueryError("分页参数必须为整数。");
  const issue=input.issue||"bad",bodyId=input.bodyId||"";
  if(!["all","bad","inverted","degenerate","invalid"].includes(issue))throw new MeshQualityQueryError("不支持此问题类型。");
  if(bodyId&&!job.source.bodies.some(body=>body.bodyId===bodyId))throw new MeshQualityQueryError("筛选 Body 不属于此网格来源。");
  return {threshold,offset,limit,issue,bodyId};
}

/** Threshold changes filter saved numeric diagnostics only: never start Gmsh or mutate geometry. */
export function queryMeshQuality(index,job,input={}) {
  const {threshold,offset,limit,issue,bodyId}=normalizeMeshQualityQuery(index,job,input);
  const histogram=Array.from({length:11},(_,i)=>({lower:i===0?-1:(i-1)/10,upper:i===0?0:i/10,includeUpper:i===10,count:0}));
  const summary={qualityName:index.qualityName,threshold,tetraCount:0,finiteCount:0,nonFiniteQualityCount:0,badCount:0,invertedCount:0,degenerateCount:0,invalidCount:0,minQuality:null,maxQuality:null,averageQuality:null,histogram,outOfRangeCount:0};
  const total={sum:0,compensation:0},matches=[];
  for(const cell of index.cells) {
    if(bodyId&&!cell.bodyIds.includes(bodyId))continue;
    const state=qualityCellState(cell,index),bad=state.invalid||state.inverted||state.degenerate||cell.quality!==null&&cell.quality<threshold;
    summary.tetraCount++;if(bad)summary.badCount++;for(const type of ["invalid","inverted","degenerate"])if(state[type])summary[type+"Count"]++;
    if(cell.quality!==null){summary.finiteCount++;addQualityValue(total,cell.quality);summary.minQuality=summary.minQuality===null?cell.quality:Math.min(summary.minQuality,cell.quality);summary.maxQuality=summary.maxQuality===null?cell.quality:Math.max(summary.maxQuality,cell.quality);
      const bin=histogram.find(bin=>cell.quality>=bin.lower&&(cell.quality<bin.upper||bin.includeUpper&&cell.quality<=bin.upper));if(bin)bin.count++;else summary.outOfRangeCount++;
    }else summary.nonFiniteQualityCount++;
    if(issue==="all"||issue==="bad"&&bad||state[issue])matches.push({cell,state});
  }
  if(summary.finiteCount)summary.averageQuality=(total.sum+total.compensation)/summary.finiteCount;
  const rank=state=>state.invalid?0:state.inverted?1:state.degenerate?2:3;
  matches.sort((a,b)=>rank(a.state)-rank(b.state)||(a.cell.quality??0)-(b.cell.quality??0)||a.cell.elementId.length-b.cell.elementId.length||a.cell.elementId.localeCompare(b.cell.elementId));
  const identities=Object.fromEntries(job.source.bodies.map(body=>[body.bodyId,{bodyIdentity:body.bodyIdentity,topologyIdentity:body.topologyIdentity}]));
  const cells=matches.slice(offset,offset+limit).map(({cell,state})=>{
    const corners=cell.corners.flatMap(n=>index.positions.slice(n*3,n*3+3)),locatable=corners.every(value=>value!==null);
    return {...cell,...state,corners:locatable?corners:null,locatable,bodyIdentities:Object.fromEntries(cell.bodyIds.map(id=>[id,identities[id]]))};
  });
  return {quality:summary,total:matches.length,offset,limit,cells,bodyId,issue};
}
