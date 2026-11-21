import crypto from 'node:crypto';
import {cadDiscreteTetraFixture} from './cad-discrete-tetra-fixture.mjs';
import {patchedTetraFixture} from './patched-tetra-fixture.mjs';
import {tetraHealth} from './discrete-tetra-fixture.mjs';
import {captureCadMeshMaterials} from '../../gateway/cad-mesh-materials.mjs';
import {cadPatchedTetraInput,assembleCadDiscreteTetraResult,CAD_CONSTRAINED_TETRA_SOURCE_BASIS} from '../../gateway/cad-discrete-tetra.mjs';
import {PATCHED_DISCRETE_TETRA_PROTOCOL as P} from '../../gateway/patched-tetra-protocol.mjs';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function cadConstrainedTetraFixture({sheet='embedded'}={}){
  const f=cadDiscreteTetraFixture(),native=patchedTetraFixture({sheet}),body={bodyId:'body-2',kind:'sheet',bodyIdentity:'2'.repeat(32),topologyIdentity:'4'.repeat(32),topologyRevision:1},faceId='face-1-1';
  f.source.bodies.push(body);f.bundle.source=structuredClone(f.source);
  f.bundle.inventory.bodies.push({...body,geometryFingerprint:'e'.repeat(64),faceCount:1,solidCount:0});
  f.bundle.inventory.faces.push({...structuredClone(f.bundle.inventory.faces[0]),bodyId:body.bodyId,faceId,faceIndex:0,triangleStart:12,triangleCount:1,uses:[{useIndex:0,solidId:'',orientation:'forward',triangleStart:12,triangleCount:1}]});
  const triangle=native.input.domain.triangles[12],base=f.bundle.input.points.length;f.bundle.input.points.push(...triangle.map(i=>[...native.input.domain.points[i]]));f.bundle.input.triangles.push([base,base+1,base+2]);f.bundle.input.sources.push({bodyId:body.bodyId,faceId});
  Object.assign(f.bundle.report,{bodyCount:2,faceCount:7,solidCount:1,triangleCount:13});
  Object.assign(f.binding,{source:structuredClone(f.source),bundleSha256:hash(f.bundle),inputSha256:hash(f.bundle.input),geometryFingerprints:{'body-1':'d'.repeat(64),'body-2':'e'.repeat(64)}});
  f.view.bodyCount=2;f.view.bodyMetadata.push({...body,material:''});
  f.snapshot.version=2;f.snapshot.basis=CAD_CONSTRAINED_TETRA_SOURCE_BASIS;f.snapshot.materials=captureCadMeshMaterials(f.view,f.source);
  const domain=native.input.domain;domain.sources=structuredClone(f.bundle.input.sources);domain.sourceSolids=[{bodyId:'body-1',solidId:'solid-body-1-0',volume:8,partitionVolume:8}];
  const input=cadPatchedTetraInput(f.snapshot,domain),output=native.output;Object.assign(output,{sources:structuredClone(domain.sources),sourceSolids:structuredClone(domain.sourceSolids),patchDomainSha256:input.patchPlan.domainSha256,patchSourceInputSha256:input.patchPlan.sourceInputSha256});
  for(let i=0;i<output.patches.length;i++){const plan=input.patchPlan.patches[i];Object.assign(output.patches[i],{sourceFaces:structuredClone(plan.sourceFaces),sourceTriangleIndexes:[...plan.triangleIndexes],sourceTriangleOrientations:[...plan.triangleOrientations],cellUses:structuredClone(plan.cellUses),constraint:structuredClone(plan.constraint)});}
  output.processResources={...tetraHealth().capabilities.processResources};output.algorithm={version:1,basis:P.basis,gmshVersion:P.gmshVersion,apiVersion:P.apiVersion,license:P.license,patchTopologyBasis:P.patchTopologyBasis};output.execution={basis:'single-process-exit-confirmed-v1',exitCode:0,automaticReplay:false};
  const result=assembleCadDiscreteTetraResult(f.snapshot,domain,output,{patchPlan:input.patchPlan});return {...f,domain,output,input,result,sheetBody:body};
}
