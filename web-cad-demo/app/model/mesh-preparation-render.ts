import * as THREE from "three";
import type {MeshPreparationPreview} from "./mesh";
import {localizePositions,placeViewportObject} from './viewport-coordinates';

/** A display-only snapshot: no CAD Body/Face identifiers or picking registration. */
export function createPreparationPreview(preview:MeshPreparationPreview) {
  if(!preview.positions.length||preview.positions.length%9!==0||preview.positions.some(value=>!Number.isFinite(value)))return null;
  const segments:number[]=[];for(const edge of preview.edges||[])for(let i=3;i<edge.points.length;i+=3)segments.push(...edge.points.slice(i-3,i),...edge.points.slice(i,i+3));
  // Validate both buffers before allocating scene resources.
  const faces=localizePositions(preview.positions),edges=localizePositions(segments);
  const group=new THREE.Group();group.userData.diagnostic=true;group.name="mesh-preparation-preview";
  const geometry=new THREE.BufferGeometry(),origin=faces.origin;geometry.setAttribute('position',new THREE.BufferAttribute(faces.positions,3));geometry.setAttribute("normal",new THREE.Float32BufferAttribute(preview.normals,3));
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0x7d9cbb,metalness:0,roughness:.85,side:THREE.DoubleSide}));placeViewportObject(mesh,origin);mesh.castShadow=false;mesh.receiveShadow=false;group.add(mesh);
  if(segments.length){const lines=new THREE.BufferGeometry();lines.setAttribute('position',new THREE.BufferAttribute(edges.positions,3));const object=new THREE.LineSegments(lines,new THREE.LineBasicMaterial({color:0x245c87}));placeViewportObject(object,edges.origin);group.add(object);}
  return group;
}
