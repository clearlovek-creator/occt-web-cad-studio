import crypto from 'node:crypto';
import {discreteTaskFixture} from './discrete-task-fixture.mjs';
import {volumeInput,verifiedDomain,tetraResult,tetraHealth} from './discrete-tetra-fixture.mjs';
import {normalizeDiscreteTetraSettings} from '../../shared/discrete-tetra-task.mjs';
import {captureCadMeshMaterials} from '../../gateway/cad-mesh-materials.mjs';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function cadDiscreteTetraFixture({materials=['Copper']}={}){
  const f=discreteTaskFixture(),cube=volumeInput(),settings=normalizeDiscreteTetraSettings(),source=structuredClone(f.source),bundle=structuredClone(f.bundle);
  source.bodies=materials.map((_,i)=>({...source.bodies[0],bodyId:'body-'+(i+1),bodyIdentity:String(i+1).repeat(32),topologyIdentity:String(i+3).repeat(32)}));
  bundle.source=structuredClone(source);bundle.policy={...bundle.policy,...settings.source};
  bundle.inventory={bodies:source.bodies.map(body=>({...body,geometryFingerprint:'d'.repeat(64),faceCount:6,solidCount:1})),solids:source.bodies.map(body=>({bodyId:body.bodyId,solidId:'solid-'+body.bodyId+'-0',solidIndex:0})),faces:[]};
  bundle.input={units:'mm',points:[],triangles:[],sources:[]};
  for(const body of source.bodies)for(let faceIndex=0;faceIndex<6;faceIndex++){
    const start=bundle.input.triangles.length,solidId='solid-'+body.bodyId+'-0',faceId='face-1-'+(faceIndex+1);
    bundle.inventory.faces.push({...structuredClone(f.bundle.inventory.faces[0]),bodyId:body.bodyId,faceId,faceIndex,triangleStart:start,triangleCount:2,uses:[{useIndex:0,solidId,orientation:'forward',triangleStart:start,triangleCount:2}]});
    for(let t=2*faceIndex;t<2*faceIndex+2;t++){
      const offset=bundle.input.points.length;bundle.input.points.push(...cube.triangles[t].map(index=>[...cube.points[index]]));bundle.input.triangles.push([offset,offset+1,offset+2]);bundle.input.sources.push({bodyId:body.bodyId,faceId,solidId});
    }
  }
  bundle.report={...bundle.report,bodyCount:materials.length,faceCount:6*materials.length,solidCount:materials.length,triangleCount:12*materials.length};
  const binding={...f.binding,source:structuredClone(source),bundleSha256:hash(bundle),inputSha256:hash(bundle.input),approximationPolicy:{...bundle.policy},geometryFingerprints:Object.fromEntries(source.bodies.map(body=>[body.bodyId,'d'.repeat(64)]))};
  const definitions=['Copper','Steel'].map((name,i)=>({name,category:'conductor',relativePermittivity:1,conductivity:i?1.45e6:5.8e7,color:'#b87333',builtIn:true}));
  const view={ok:true,protocolVersion:1,documentId:'doc',revision:1,bodyCount:materials.length,bodyMetadata:source.bodies.map((body,i)=>({...body,material:materials[i]||''})),materials:definitions};
  const snapshot={version:1,basis:'cad-discrete-tetra-source-v1',cad:{bundle,source,binding},materials:captureCadMeshMaterials(view,source),settings};
  const domain=verifiedDomain(),indexes=source.bodies.map((_,i)=>i);domain.sources=structuredClone(bundle.input.sources);domain.sourceSolids=source.bodies.map(body=>({bodyId:body.bodyId,solidId:'solid-'+body.bodyId+'-0',volume:8,partitionVolume:8}));domain.regions[0].sourceSolidIndexes=[...indexes];domain.cells[0].sourceSolidIndexes=[...indexes];domain.sourceTriangleIds=domain.triangles.map((_,i)=>indexes.map(index=>12*index+i));
  domain.surfaceReport.inputTriangles=12*materials.length;domain.surfaceReport.sourceReferences=12*materials.length;
  const output=tetraResult();output.sources=structuredClone(domain.sources);output.sourceSolids=structuredClone(domain.sourceSolids);output.cells[0].sourceSolidIndexes=[...indexes];output.boundaries.forEach((boundary,i)=>boundary.sourceTriangleIds=[...domain.sourceTriangleIds[i]]);
  output.processResources={...tetraHealth().capabilities.processResources};output.algorithm={version:1,basis:output.basis,gmshVersion:'4.15.2',apiVersion:'4.15.2',license:'GPL-3.0-or-later'};output.execution={basis:'single-process-exit-confirmed-v1',exitCode:0,automaticReplay:false};
  return {snapshot,source,bundle,binding,view,domain,output,clients:{partitionClient:{partition:async()=>structuredClone(domain)},tetraClient:{tetrahedralize:async()=>structuredClone(output)}}};
}
