import {selectGeometry} from './generated-topology-fixtures.mjs';
const near=(a,b)=>Math.abs(a-b)<1e-5;
export function sweepRepairSelection(documentId,response,index){const p=response.inputPreview;return {documentId,featureId:p.featureId,sweepInputId:p.sweepInputId,sourceBodyId:p.sourceBodyId,sourceBodyIdentity:p.sourceBodyIdentity,sourceFeatureId:p.sourceFeatureId,kind:p.kind,inputFingerprint:p.inputFingerprint,index};}
export async function createSweepProfileRepairFixture(cad,id,mode='feature'){
  if(mode==='variable')await cad(id,'variable.set',{name:'sweepSlotX',type:'length',expression:'40 mm'});
  if(mode==='coordinate')await cad(id,'coordinate.set',{id:'sweep_slot_frame',name:'Sweep slot',origin:[40,0,-5],xAxis:[1,0,0],yAxis:[0,1,0]});
  const box=await cad(id,'primitive.box',{width:20,depth:20,height:10}),tool=await cad(id,'primitive.box',{width:4,depth:20,height:20,...(mode==='coordinate'?{coordinateSystemId:'sweep_slot_frame'}:{x:mode==='variable'?'sweepSlotX':40,z:-5})});
  const cut=await cad(id,'boolean.cut',{}, {targetBody:box.bodyId,toolBody:tool.bodyId}),face=await selectGeometry(cad,id,cut,'face',m=>near(m.centroid[2],10));
  const route=await cad(id,'primitive.box',{width:10,depth:10,height:20,x:50,y:50}),edge=await selectGeometry(cad,id,route,'edge',m=>near(m.length,20)&&near(m.centroid[0],50)&&near(m.centroid[1],50));
  const result=await cad(id,'detail.sweep',{placement:'align-start'},{bodyId:cut.bodyId,faceId:face,pathBodyId:route.bodyId,pathEdgeIds:[edge]});
  const proposal=mode==='variable'?{operation:'variable.set',parameters:{name:'sweepSlotX',type:'length',expression:'8 mm'}}:mode==='coordinate'?{operation:'coordinate.set',parameters:{id:'sweep_slot_frame',name:'Sweep slot',origin:[8,0,-5],xAxis:[1,0,0],yAxis:[0,1,0]}}:{operation:'feature.update',inputs:{featureId:tool.features.at(-1).id},parameters:{x:8}};
  return {cut,route,result,featureId:result.features.at(-1).id,proposal};
}
export async function createSweepPathRepairFixture(cad,id){
  const box=await cad(id,'primitive.box',{width:20,depth:20,height:30}),tool=await cad(id,'primitive.box',{width:4,depth:20,height:10,x:40,z:10});
  const cut=await cad(id,'boolean.cut',{}, {targetBody:box.bodyId,toolBody:tool.bodyId}),edge=await selectGeometry(cad,id,cut,'edge',m=>near(m.length,30)&&near(m.centroid[0],0)&&near(m.centroid[1],0));
  const profile=await cad(id,'surface.disk',{radius:1}),result=await cad(id,'detail.pipe',{placement:'align-start'},{bodyId:profile.bodyId,faceId:profile.triangleFaceIds[0],pathBodyId:cut.bodyId,pathEdgeIds:[edge]});
  const featureId=result.features.at(-1).id,inputId=JSON.parse(result.features.at(-1).stringParameters.sweepPath).edges[0].inputId;
  return {cut,profile,result,featureId,inputId,proposal:{operation:'feature.update',inputs:{featureId:tool.features.at(-1).id},parameters:{x:-2}}};
}
export function sweepRepairEdgeIndex(p,z,maxX=Infinity){
  const edge=p.edges.find(edge=>{const points=edge.points;return points[0]<=maxX+1e-5&&points[1]<1e-5&&near((points[2]+points.at(-1))/2,z)&&near(points[0],points.at(-3))&&near(points[1],points.at(-2));});
  if(!edge)throw Error('Required actual historical Edge is absent');return Number(edge.edgeId.split('-').at(-1));
}
