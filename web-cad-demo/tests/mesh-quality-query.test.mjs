import test from "node:test";
import assert from "node:assert/strict";
import {validateQualityIndex,queryMeshQuality} from "../gateway/mesh-quality-query.mjs";
const job={jobId:"test-quality",source:{bodies:[{bodyId:"body-1",bodyIdentity:"a".repeat(32),topologyIdentity:"b".repeat(32)},{bodyId:"body-2",bodyIdentity:"c".repeat(32),topologyIdentity:"d".repeat(32)}]}};
const cell=(id,quality,jac=1,bodyIds=["body-1"])=>({elementId:id,elementType:4,order:1,volumeTag:1,corners:[0,1,2,3],quality,minJacobian:jac,maxJacobian:jac,bodyIds});
const index={version:1,requestId:job.jobId,qualityName:"minSICN",threshold:.2,positions:[0,0,0,1,0,0,0,1,0,0,0,1],cells:[cell("9007199254740993",.9),cell("2",.1,1,["body-1","body-2"]),cell("3",-.1,-1),cell("4",0,0),cell("5",null,null)]};
test("quality query counts unique shared cells globally and includes every explicit Body owner",()=>{
  validateQualityIndex(index,job);const all=queryMeshQuality(index,job);
  assert.equal(all.quality.tetraCount,5);assert.equal(all.quality.badCount,4);assert.equal(all.quality.invertedCount,1);assert.equal(all.quality.degenerateCount,1);assert.equal(all.quality.invalidCount,1);
  assert.deepEqual(all.cells.map(cell=>cell.elementId),["5","3","4","2"]);
  assert.equal(all.quality.histogram.reduce((sum,bin)=>sum+bin.count,0)+all.quality.nonFiniteQualityCount,5);
  assert.equal(all.quality.averageQuality,.225);
  const shared=queryMeshQuality(index,job,{bodyId:"body-2",threshold:.05,issue:"all"});assert.equal(shared.quality.tetraCount,1);assert.equal(shared.quality.badCount,0);assert.deepEqual(shared.cells[0].bodyIds,["body-1","body-2"]);assert.equal(shared.cells[0].bodyIdentities["body-2"].topologyIdentity,"d".repeat(32));
});
test("quality pagination, IDs and non-locatable coordinates are exact and fail closed",()=>{
  const page=queryMeshQuality(index,job,{issue:"all",offset:4,limit:1});assert.equal(page.cells[0].elementId,"9007199254740993");assert.deepEqual(page.cells[0].corners,index.positions);
  for(const input of [{threshold:"bad"},{threshold:-1},{offset:-1},{limit:101},{offset:1.5},{issue:"guess"},{bodyId:"unknown"}])assert.throws(()=>queryMeshQuality(index,job,input),/不合法|不支持|不属于|必须为整数/);
  assert.throws(()=>validateQualityIndex({...index,cells:[cell("1",.5,1,["unknown"])]},job),/归属/);
  assert.throws(()=>validateQualityIndex({...index,cells:[cell("1",.5),cell("1",.4)]},job),/重复/);
  const unknown=structuredClone(index);unknown.positions[0]=null;validateQualityIndex(unknown,job);const result=queryMeshQuality(unknown,job,{issue:"all"});assert.equal(result.cells.every(cell=>!cell.locatable&&cell.corners===null),true);
});
