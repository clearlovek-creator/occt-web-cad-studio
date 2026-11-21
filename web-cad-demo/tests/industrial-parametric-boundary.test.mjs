import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {gatedGeometryGateway} from './helpers/gated-geometry-gateway.mjs';
const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<=1e-7*Math.max(1,Math.abs(expected)),`${label}: ${actual} != ${expected}`);
async function fixture(){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'cad-industrial-boundary-'));let f;
  try{f=await gatedGeometryGateway(data,{GEOMETRY_WORKER_TIMEOUT_MS:'60000',MESH_WORKER_TIMEOUT_MS:'120000'});}catch(error){if(error.fixture)await error.fixture.stop();throw error;}
  const cad=(operation,parameters={},inputs={},id='default')=>f.cad(operation,parameters,inputs,id);
  return {f,data,cad,async finish(verified){assert.equal(await f.stop(),0);if(verified){assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.match(path.basename(data),/^cad-industrial-boundary-/);fs.rmSync(data,{recursive:true,force:true});}else console.error('Retained industrial boundary diagnostics:',data);}};
}
async function pick(cad,bodyId,kind,predicate,id='default'){
  const view=await cad('body.presentation',{}, {bodyId},id),ids=kind==='face'?[...new Set(view.triangleFaceIds)]:view.edges.map(edge=>edge.edgeId);
  const inspected=[];for(const selectionId of ids){const measured=await cad('geometry.measure',{}, {bodyId,selectionType:kind,selectionId},id);inspected.push({id:selectionId,area:measured.area,length:measured.length,centroid:measured.centroid});if(predicate(measured))return selectionId;}
  throw Error('Required '+kind+' not found: '+JSON.stringify(inspected));
}
async function board(cad){
  await cad('variable.set',{name:'boardL',type:'length',expression:'60 mm'});await cad('variable.set',{name:'boardT',type:'length',expression:'3 mm'});
  const base=await cad('primitive.box',{width:'boardL',depth:40,height:'boardT'}),first=await cad('primitive.cylinder',{radius:3,height:'boardT + 2 mm',x:15,y:20,z:-1});
  await cad('boolean.cut',{}, {targetBody:base.bodyId,toolBody:first.bodyId});
  const second=await cad('primitive.cylinder',{radius:3,height:'boardT + 2 mm',x:45,y:20,z:-1});await cad('boolean.cut',{}, {targetBody:base.bodyId,toolBody:second.bodyId});
  const slot=await cad('primitive.box',{width:6,depth:20,height:'boardT + 2 mm',x:27,y:10,z:-1});await cad('boolean.cut',{}, {targetBody:base.bodyId,toolBody:slot.bodyId});
  const edge=await pick(cad,base.bodyId,'edge',m=>Math.abs(m.centroid[0])<1e-8&&Math.abs(m.centroid[1])<1e-8&&Math.abs(m.length-3)<1e-8);
  await cad('detail.fillet',{radius:1.5},{bodyId:base.bodyId,edgeId:edge});
  const port=await pick(cad,base.bodyId,'face',m=>Math.abs(m.centroid[0]-60)<1e-8&&Math.abs(m.area-120)<1e-8),bore=await pick(cad,base.bodyId,'face',m=>Math.abs(m.centroid[0]-15)<1e-8&&Math.abs(m.centroid[1]-20)<1e-8&&Math.abs(m.area-18*Math.PI)<1e-6);
  const type=await cad('property.type.create',{key:'IndustrialBoundary',targetScope:'face',association:'required',fields:[{key:'impedance',type:'double',required:true},{key:'purpose',type:'enum',options:['end-port','bore-wall'],required:true}]}),instances=[];
  for(const [index,[topologyId,purpose]] of [[port,'end-port'],[bore,'bore-wall']].entries()){const added=await cad('property.instance.create',{typeId:type.type.typeId,name:purpose,value:{impedance:50,purpose},target:{kind:'face',bodyId:base.bodyId,topologyId}});instances.push(added.instance.instanceId);await cad('property.set',{key:'industrialBoundary',type:'int',value:index+1},{kind:'face',bodyId:base.bodyId,topologyId});}
  return {bodyId:base.bodyId,baseFeatureId:base.features.at(-1).id,boreFeatureId:first.features.at(-1).id,instances};
}
async function boundaries(cad,fixture,{length=60,thickness=3,radius=3,id='default'}={}){
  const listed=(await cad('property.instance.list',{}, {},id)).instances,raw=(await cad('property.list',{}, {},id)).propertyRecords;
  for(const [index,purpose] of ['end-port','bore-wall'].entries()){
    const item=listed.find(row=>row.instanceId===fixture.instances[index]);assert.equal(item.state,'active',JSON.stringify(item));assert.equal(item.value.purpose,purpose);assert.equal(item.value.impedance,50);
    const measured=await cad('geometry.measure',{}, {bodyId:item.target.bodyId,selectionType:'face',selectionId:item.target.topologyId},id);
    near(measured.area,index===0?40*thickness:2*Math.PI*radius*thickness,purpose+' area');near(measured.centroid[0],index===0?length:15,purpose+' x');near(measured.centroid[1],20,purpose+' y');near(measured.centroid[2],thickness/2,purpose+' z');
    const attached=raw.filter(row=>row.state==='active'&&row.values?.industrialBoundary?.value===index+1);assert.equal(attached.length,1,JSON.stringify(raw));assert.equal(attached[0].topologyId,item.target.topologyId,'Native and typed values must refer to the exact same current face');
  }
  return listed;
}
test('industrial drilled/slotted/filleted board retains exact final-face boundaries through parameter changes, disappearing geometry, Undo/Redo and portable reopen',async()=>{
  const x=await fixture();let verified=false;try{
    const model=await board(x.cad);await boundaries(x.cad,model);const stored=()=>JSON.parse(fs.readFileSync(path.join(x.data,'property-schemas/default.json'),'utf8')),anchors=stored().instances.map(item=>item.target);
    await x.cad('variable.set',{name:'boardL',type:'length',expression:'80 mm'});await boundaries(x.cad,model,{length:80});
    await x.cad('variable.set',{name:'boardT',type:'length',expression:'4 mm'});await boundaries(x.cad,model,{length:80,thickness:4});
    await x.cad('feature.update',{radius:4},{featureId:model.boreFeatureId});await boundaries(x.cad,model,{length:80,thickness:4,radius:4});assert.deepEqual(stored().instances.map(item=>item.target),anchors,'Reads and recomputation cannot replace the original anchors with current indices');
    const before=await x.cad('document.summary');await x.cad('feature.update',{x:100},{featureId:model.boreFeatureId});const disappeared=(await x.cad('property.instance.list')).instances;assert.equal(disappeared.find(row=>row.instanceId===model.instances[0]).state,'active');assert.notEqual(disappeared.find(row=>row.instanceId===model.instances[1]).state,'active','A missing hole wall must not move to another cylindrical or planar face');
    await x.cad('document.undo');await boundaries(x.cad,model,{length:80,thickness:4,radius:4});assert.deepEqual((await x.cad('document.summary')).features,before.features);await x.cad('document.redo');assert.notEqual((await x.cad('property.instance.list')).instances.find(row=>row.instanceId===model.instances[1]).state,'active');await x.cad('document.undo');
    const response=await fetch(x.f.api+'/documents/default/project/save',{method:'POST'});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer()),opened=await fetch(x.f.api+'/documents/portable/project/open',{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project'},body:bytes});assert.equal(opened.status,200,await opened.text());
    await x.cad('variable.set',{name:'boardT',type:'length',expression:'5 mm'}, {},'portable');await boundaries(x.cad,model,{length:80,thickness:5,radius:4,id:'portable'});verified=true;
  }finally{await x.finish(verified);}
});
test('the same final-face boundaries remain correctly owned in a conformal board/film/enclosure mesh and become stale after geometry changes',async()=>{
  const x=await fixture();let verified=false;try{
    const model=await board(x.cad);await x.cad('variable.set',{name:'boardL',type:'length',expression:'80 mm'});await x.cad('variable.set',{name:'boardT',type:'length',expression:'4 mm'});await boundaries(x.cad,model,{length:80,thickness:4});
    const film=await x.cad('primitive.box',{width:70,depth:30,height:.035,x:5,y:5,z:4}),air=await x.cad('primitive.box',{width:90,depth:50,height:14,x:-5,y:-5,z:-5});const submitted=await x.f.post('/documents/default/mesh/jobs',{background:true,repairMode:'conservative',qualityThreshold:.2});assert.equal(submitted.status,202,JSON.stringify({status:submitted.status,error:submitted.value.error,code:submitted.value.code,state:submitted.value.meshJob?.state}));const jobId=submitted.value.meshJob.jobId;
    const completed=await x.f.until(async()=>{const result=await x.f.get('/mesh/jobs/'+jobId);assert.equal(result.ok,true,JSON.stringify(result));if(['failed','cancelled','interrupted'].includes(result.meshJob.state))throw Error(JSON.stringify(result.meshJob));return result.meshJob.state==='complete'?result:null;},'Industrial board mesh did not complete',120000);assert.equal(completed.meshJob.visible,false);
    assert.equal(completed.mesh.admission.status,'warning','Conformity is not a claim that an extremely thin isotropic mesh meets the quality threshold');assert.equal(completed.mesh.admission.usable,true);assert.equal(completed.mesh.admission.counts.invertedCount,0);assert.equal(completed.mesh.admission.counts.degenerateCount,0);assert.ok(completed.mesh.admission.counts.lowQualityCount>0);assert.ok(completed.mesh.admission.reasons.some(row=>row.code==='LOW_QUALITY_ELEMENTS'));
    const report=await x.f.get('/mesh/jobs/'+jobId+'/boundary');assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.boundary.complete,true);assert.equal(report.boundary.propertyStatus,'current');const owned=new Set(report.boundary.sourceFaces.map(row=>row.source.bodyId));assert.deepEqual(owned,new Set([model.bodyId,film.bodyId,air.bodyId]));
    for(const instanceId of model.instances){const tagged=report.boundary.sourceFaces.filter(row=>row.properties.some(p=>p.instanceId===instanceId));assert.equal(tagged.length,1,'Exactly the semantic original source face receives this boundary');assert.equal(tagged[0].source.bodyId,model.bodyId);assert.equal(tagged[0].state,'mapped');assert.ok(tagged[0].surfaceTags.length>0);}
    await x.cad('property.instance.update',{value:{impedance:75,purpose:'end-port'}},{instanceId:model.instances[0]});const updated=await x.f.get('/mesh/jobs/'+jobId+'/boundary');assert.equal(updated.boundary.propertyStatus,'current');assert.ok(updated.boundary.sourceFaces.some(row=>row.properties.some(p=>p.instanceId===model.instances[0]&&p.value.impedance===75)));
    await x.cad('variable.set',{name:'boardL',type:'length',expression:'82 mm'});const stale=await x.f.get('/mesh/jobs/'+jobId+'/boundary');assert.equal(stale.boundary.propertyStatus,'source-stale');assert.ok(stale.boundary.sourceFaces.every(row=>row.properties.length===0),'Old mesh must not inherit properties from newer geometric faces');verified=true;
  }finally{await x.finish(verified);}
});

test('proven impossible planar edge details are rejected without replacing the worker or changing the project, and valid thin-plate details remain editable',async()=>{
  const x=await fixture();let verified=false;try{
    for(const [operation,key] of [['detail.fillet','radius'],['detail.chamfer','distance']]){
      const base=await x.cad('primitive.box',{width:40,depth:30,height:1}),edge=await pick(x.cad,base.bodyId,'edge',m=>Math.abs(m.centroid[0])<1e-8&&Math.abs(m.centroid[1])<1e-8&&Math.abs(m.length-1)<1e-8);
      const reject=async(operation,parameters,inputs)=>{
        const before=await x.cad('document.summary'),result=await x.f.post('/commands',{requestId:randomUUID(),documentId:'default',operation,parameters,inputs,baseRevision:before.revision,baseStateToken:before.stateToken});
        assert.equal(result.status,400,JSON.stringify(result.value));assert.equal(result.value.ok,false,'Impossible geometry must not commit');assert.equal(result.value.code,'INVALID_PARAMETER');assert.match(result.value.error,/adjacent planar faces/);
        const after=await x.cad('document.summary');for(const key of ['revision','stateToken','bodyCount','features','bodyMetadata','entityIdentities'])assert.deepEqual(after[key],before[key],key+' changed after rejected edge detail');
        console.log('EDGE_FAILURE_RECOVERY '+JSON.stringify({operation,code:result.value.code,rollbackConfirmed:result.value.projectRollback?.confirmed??false,subsequentReadVerified:true}));
      };
      await reject(operation,{[key]:100},{bodyId:base.bodyId,edgeId:edge});
      const added=await x.cad(operation,{[key]:5},{bodyId:base.bodyId,edgeId:edge});await reject('feature.update',{[key]:100},{featureId:added.features.at(-1).id});
      await x.cad('feature.update',{[key]:8},{featureId:added.features.at(-1).id});assert.equal((await x.cad('geometry.check',{}, {bodyId:base.bodyId})).valid,true);
    }
    assert.equal(x.f.events.filter(row=>row.type==='fixture.geometry-start').length,1,'Invalid planar parameters must not require a replacement geometry process');assert.equal(x.f.events.filter(row=>row.type==='fixture.geometry-exit').length,0);
    verified=true;
  }finally{await x.finish(verified);}
});
