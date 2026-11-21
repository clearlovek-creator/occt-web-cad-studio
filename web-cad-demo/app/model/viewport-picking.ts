import * as THREE from 'three';
import { type ViewportCamera, viewportViewHeight } from './viewport-camera';

/** A pixel-sized aperture, not a fixed engineering-unit radius. */
export function viewportPixelSize(camera:ViewportCamera,height:number,target:THREE.Vector3){
  return Math.max(1e-12,viewportViewHeight(camera,camera.position.distanceTo(target))/Math.max(1,height));
}
export function viewportRaycaster(mouse:THREE.Vector2,camera:ViewportCamera,height:number,target:THREE.Vector3){
  camera.updateMatrixWorld(true);
  const ray=new THREE.Raycaster();ray.setFromCamera(mouse,camera);
  ray.layers.enableAll();
  ray.params.Line.threshold=viewportPixelSize(camera,height,target)*5;
  return ray;
}
function inClip(point:THREE.Vector3,camera:THREE.Camera){const z=point.clone().project(camera).z;return Number.isFinite(z)&&z>=-1&&z<=1;}
export function pickViewportBody(ray:THREE.Raycaster,meshes:THREE.Mesh[],camera:THREE.Camera){
  const visible=meshes.filter(mesh=>mesh.visible);visible.forEach(mesh=>mesh.updateWorldMatrix(true,false));
  return ray.intersectObjects(visible,false).find(hit=>inClip(hit.point,camera));
}
export function pickViewportEdge(ray:THREE.Raycaster,lines:THREE.Line[],meshes:THREE.Mesh[],camera:THREE.Camera){
  const visible=lines.filter(line=>line.visible);visible.forEach(line=>line.updateWorldMatrix(true,false));
  const opaque=meshes.filter(mesh=>{const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];return materials.every(material=>material.visible&&material.opacity>=.999);});
  const occluder=pickViewportBody(ray,opaque,camera),tolerance=ray.params.Line.threshold*1.2;
  return ray.intersectObjects(visible,false).find(hit=>inClip(hit.point,camera)&&(!occluder||hit.distance<=occluder.distance+tolerance));
}
