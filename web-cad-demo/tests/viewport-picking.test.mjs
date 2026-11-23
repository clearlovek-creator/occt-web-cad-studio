import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {importTestTypeScript} from './helpers/import-typescript.mjs';
const {viewportRaycaster,pickViewportBody,pickViewportEdge,viewportPixelSize}=await importTestTypeScript('../app/model/viewport-picking.ts',import.meta.url);
const {viewportFitDistance,visibleViewportBounds,viewportFov,setViewportDisplay,edgeLayer}=await importTestTypeScript('../app/model/viewport-camera.ts',import.meta.url);
const {constructionSnapCandidates,pickConstructionSnap}=await importTestTypeScript('../app/modeling/construction-snap.ts',import.meta.url);
const {constructionFrame,GLOBAL_CONSTRUCTION_COORDINATE}=await importTestTypeScript('../app/modeling/construction-frame.ts',import.meta.url);
test('shaded mode exposes real edges while the edge selection tool is active',()=>{
  const view=new THREE.PerspectiveCamera();
  setViewportDisplay(view,"shaded"); assert.equal(view.layers.isEnabled(edgeLayer),false);
  setViewportDisplay(view,"shaded",true); assert.equal(view.layers.isEnabled(edgeLayer),true);
  setViewportDisplay(view,"shaded"); assert.equal(view.layers.isEnabled(edgeLayer),false);
});
function camera(scale=1,offset=0){const value=new THREE.PerspectiveCamera(40,1,scale/1000,scale*100);value.position.set(offset,offset,offset+scale*10);value.lookAt(offset,offset,offset);value.updateMatrixWorld(true);return value;}
function line(z=0,scale=1,offset=0){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-scale,0,z,scale,0,z],3));const object=new THREE.Line(geometry,new THREE.LineBasicMaterial());object.position.setScalar(offset);return object;}
function plane(z=1){const mesh=new THREE.Mesh(new THREE.PlaneGeometry(4,4),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.position.z=z;return mesh;}
function dispose(...objects){for(const object of objects){object.geometry.dispose();object.material.dispose();}}
test('edge aperture stays five screen pixels for tiny, ordinary and far-origin models',()=>{
  for(const [scale,offset] of [[.001,0],[1,0],[1,1e9]]){
    const view=camera(scale,offset),edge=line(0,scale,offset),target=new THREE.Vector3(offset,offset,offset),pixel=viewportPixelSize(view,1000,target);
    try{const hitRay=viewportRaycaster(new THREE.Vector2(0,8/1000),view,1000,target),missRay=viewportRaycaster(new THREE.Vector2(0,16/1000),view,1000,target);assert.equal(hitRay.params.Line.threshold,pixel*5);assert.ok(pickViewportEdge(hitRay,[edge],[],view));assert.equal(pickViewportEdge(missRay,[edge],[],view),undefined);}finally{dispose(edge);}
  }
});
test('opaque faces block rear-edge picks while transparent or hidden bodies do not',()=>{
  const view=camera(),edge=line(),body=plane(),ray=viewportRaycaster(new THREE.Vector2(),view,1000,new THREE.Vector3());
  try{assert.ok(pickViewportBody(ray,[body],view));assert.equal(pickViewportEdge(ray,[edge],[body],view),undefined);body.material.transparent=true;body.material.opacity=.4;assert.ok(pickViewportEdge(ray,[edge],[body],view));body.material.opacity=1;body.visible=false;assert.ok(pickViewportEdge(ray,[edge],[body],view));edge.visible=false;assert.equal(pickViewportEdge(ray,[edge],[body],view),undefined);}finally{dispose(edge,body);}
});
test('selection excludes camera-clipped faces and edges and observes transforms before a render frame',()=>{
  const view=camera(),edge=line(9.9999),body=plane(9.9999),target=new THREE.Vector3();
  try{let ray=viewportRaycaster(new THREE.Vector2(),view,1000,target);assert.equal(pickViewportBody(ray,[body],view),undefined);assert.equal(pickViewportEdge(ray,[edge],[],view),undefined);body.position.z=1;ray=viewportRaycaster(new THREE.Vector2(),view,1000,target);assert.ok(pickViewportBody(ray,[body],view));body.position.x=20;assert.equal(pickViewportBody(ray,[body],view),undefined);}finally{dispose(edge,body);}
});

test('construction snapping uses exact in-plane geometry, a screen aperture, and visible surfaces', () => {
  const view = camera(), edge = line(), cover = plane();
  const frame = constructionFrame(GLOBAL_CONSTRUCTION_COORDINATE);
  edge.userData.snap = { endpoints: [[.125, .25, 0], [1, 1, .01]], midpoint: [.375, .25, 0] };
  const candidates = constructionSnapCandidates([edge], frame);
  const mouseAt = (x, y) => {
    const projected = new THREE.Vector3(x, y, 0).project(view);
    return new THREE.Vector2(projected.x, projected.y);
  };
  const pick = (cursor, occluders = []) => pickConstructionSnap(candidates, cursor, 1000, 1000, view, occluders);
  try {
    assert.equal(candidates.length, 2);
    assert.equal(pick(mouseAt(1, 1)), null);
    assert.deepEqual(pick(mouseAt(.375, .25)), { x: .375, y: .25, snap: 'midpoint' });
    const endpoint = mouseAt(.125, .25);
    assert.deepEqual(pick(endpoint), { x: .125, y: .25, snap: 'endpoint' });
    assert.equal(pick(endpoint, [cover]), null);
    cover.material.opacity = .4;
    assert.equal(pick(endpoint, [cover])?.snap, 'endpoint');
    assert.equal(pick(endpoint.clone().add(new THREE.Vector2(0, .022))), null);
    edge.visible = false;
    assert.equal(pick(endpoint), null);
  } finally { dispose(edge, cover); }
});
test('fit ignores a distant hidden body and keeps all visible bounds inside a narrow view',()=>{
  const shown=new THREE.Mesh(new THREE.BoxGeometry(40,12,13),new THREE.MeshBasicMaterial());
  const hidden=plane();
  hidden.position.x=10000; hidden.visible=false;
  const group=new THREE.Group();
  group.add(shown,hidden);
  try {
    const bounds=visibleViewportBounds(group);
    assert.deepEqual(bounds.min.toArray(),[-20,-6,-6.5]);
    assert.deepEqual(bounds.max.toArray(),[20,6,6.5]);
    const aspect=.3, direction=new THREE.Vector3(1,-2,1).normalize(),up=new THREE.Vector3(0,0,1);
    const distance=viewportFitDistance(bounds,direction,up,aspect);
    const view=new THREE.PerspectiveCamera(viewportFov,aspect,.01,1000);
    view.position.copy(direction).multiplyScalar(distance);
    view.up.copy(up); view.lookAt(0,0,0); view.updateMatrixWorld(true);
    for (const x of [-20,20]) for (const y of [-6,6]) for (const z of [-6.5,6.5]) {
      const point=new THREE.Vector3(x,y,z).project(view);
      assert.ok(Math.abs(point.x)<1 && Math.abs(point.y)<1);
    }
  } finally {dispose(shown,hidden);}
});
