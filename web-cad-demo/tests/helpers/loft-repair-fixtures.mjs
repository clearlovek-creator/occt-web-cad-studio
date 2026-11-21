import {selectGeometry} from './generated-topology-fixtures.mjs';
const near=(a,b)=>Math.abs(a-b)<1e-5;
export function loftRepairFaceIndex(p,z,maxX=Infinity){
  const faces=new Map();
  for(let t=0;t<p.triangleFaceIds.length;t++){
    const id=p.triangleFaceIds[t],points=faces.get(id)||[];
    for(const v of p.indices.slice(t*3,t*3+3))points.push(p.positions.slice(v*3,v*3+3));faces.set(id,points);
  }
  for(const [id,points] of faces)if(points.every(v=>near(v[2],z)&&v[0]<=maxX+1e-5))return Number(id.split('-').at(-1));
  throw Error('Required real historical Face was not rendered');
}
export async function createLoftRepairFixture(cad,id,mode='feature',both=false){
  if(mode==='variable')await cad(id,'variable.set',{name:'slotX',type:'length',expression:'40 mm'});
  if(mode==='coordinate')await cad(id,'coordinate.set',{id:'slot_frame',name:'Slot frame',origin:[40,0,-5],xAxis:[1,0,0],yAxis:[0,1,0]});
  const box=await cad(id,'primitive.box',{width:20,depth:20,height:10}),tool=await cad(id,'primitive.box',{width:4,depth:20,height:20,...(mode==='coordinate'?{coordinateSystemId:'slot_frame'}:{x:mode==='variable'?'slotX':40,z:-5})});
  const cut=await cad(id,'boolean.cut',{}, {targetBody:box.bodyId,toolBody:tool.bodyId}),top=await selectGeometry(cad,id,cut,'face',m=>near(m.centroid[2],10));
  const bottom=both?await selectGeometry(cad,id,cut,'face',m=>near(m.centroid[2],0)):null,last=both?null:await cad(id,'surface.rectangle',{width:6,height:20,x:3,y:10,z:30});
  const loft=await cad(id,'detail.loft',{}, {sections:both?[{bodyId:cut.bodyId,faceId:bottom},{bodyId:cut.bodyId,faceId:top}]:[{bodyId:cut.bodyId,faceId:top},{bodyId:last.bodyId,faceId:last.triangleFaceIds[0]}]});
  const proposal=mode==='variable'?{operation:'variable.set',parameters:{name:'slotX',type:'length',expression:'8 mm'}}:mode==='coordinate'?{operation:'coordinate.set',parameters:{id:'slot_frame',name:'Slot frame',origin:[8,0,-5],xAxis:[1,0,0],yAxis:[0,1,0]}}:{operation:'feature.update',inputs:{featureId:tool.features.at(-1).id},parameters:{x:8}};
  return {box,tool,cut,loft,last,proposal,loftFeature:loft.features.at(-1).id,refs:JSON.parse(loft.features.at(-1).stringParameters.loftSections)};
}
