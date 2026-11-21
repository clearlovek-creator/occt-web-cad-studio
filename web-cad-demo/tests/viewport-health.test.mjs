import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {viewportHealth} from "../app/model/viewport-health.ts";

test("viewport health distinguishes live scene geometry from detached caches, hidden parents and offscreen bodies",()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,1,1000),group=new THREE.Group();
  camera.position.set(0,0,100);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(10,10,10),new THREE.MeshBasicMaterial());group.add(mesh);scene.add(group);scene.updateMatrixWorld();
  assert.deepEqual(viewportHealth(scene,camera,[mesh]),{attached:1,visible:1,inFrustum:1});
  group.visible=false;assert.deepEqual(viewportHealth(scene,camera,[mesh]),{attached:1,visible:0,inFrustum:0});
  group.visible=true;mesh.position.x=100000;scene.updateMatrixWorld();assert.deepEqual(viewportHealth(scene,camera,[mesh]),{attached:1,visible:1,inFrustum:0});
  scene.remove(group);assert.deepEqual(viewportHealth(scene,camera,[mesh]),{attached:0,visible:0,inFrustum:0});
  mesh.geometry.dispose();mesh.material.dispose();
});
