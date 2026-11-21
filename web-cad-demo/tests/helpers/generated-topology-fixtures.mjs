export const originBox=Object.freeze({width:30,depth:40,height:20});
export const movedBox=Object.freeze({width:60,depth:50,height:35,x:100,y:200,z:50});
const near=(a,b)=>Math.abs(a-b)<1e-4;
export async function selectGeometry(cad,id,view,kind,predicate){for(const selectionId of kind==='face'?new Set(view.triangleFaceIds):view.edges.map(e=>e.edgeId)){const measured=await cad(id,'geometry.measure',{}, {bodyId:view.bodyId,selectionType:kind,selectionId});if(predicate(measured))return selectionId;}throw Error('Required '+kind+' not found for '+id);}
export async function createGeneratedFixture(cad,id,operation){
  const base=await cad(id,'primitive.box',originBox);const inputs={bodyId:base.bodyId};let parameters;
  if(['detail.fillet','detail.chamfer'].includes(operation)){inputs.edgeId=await selectGeometry(cad,id,base,'edge',m=>near(m.centroid[0],0)&&near(m.centroid[1],0)&&near(m.length,20));parameters=operation==='detail.fillet'?{radius:2}:{distance:2};}
  else if(operation==='detail.offset')parameters={distance:2};
  else {inputs.faceId=await selectGeometry(cad,id,base,'face',m=>operation==='detail.draft'?near(m.centroid[0],0):near(m.centroid[2],20));parameters=operation==='detail.draft'?{angleDegrees:5,neutralNormalZ:1,directionZ:1}:{thickness:2};}
  const result=await cad(id,operation,parameters,inputs);
  const face=await selectGeometry(cad,id,result,'face',m=>operation==='detail.shell'?near(m.centroid[2],2)&&near(m.area,26*36)
    :operation==='detail.thicken'?near(m.centroid[1],0)&&near(m.area,60)
    :operation==='detail.offset'?m.centroid[0]<0&&m.centroid[1]<0&&near(m.centroid[2],10)
    :operation==='detail.draft'?Math.abs(m.centroid[0])<2&&!near(m.centroid[0],0)&&near(m.centroid[2],10)
    :m.centroid[0]>0&&m.centroid[0]<2&&m.centroid[1]>0&&m.centroid[1]<2&&near(m.centroid[2],10));
  return {base,result,face};
}
