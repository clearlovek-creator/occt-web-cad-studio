import * as THREE from "three";
import type {MeshQualityCell,MeshQualitySelection,MeshSpatialCell} from "./mesh";
import {diagnosticSelectionProblem} from './mesh-spatial';
import {localizePositions,setViewportPositions,placeViewportObject,isViewportCoordinateError} from './viewport-coordinates';

/** A diagnostic layer, never inserted into the CAD picking cache. */
function createTetraHighlight(cell:MeshSpatialCell,color:number) {
  if(!cell.corners||cell.corners.length!==12||!cell.corners.every(value=>Number.isFinite(value)&&Number.isFinite(Math.fround(value))))return null;
  let local:ReturnType<typeof localizePositions>;try{local=localizePositions(cell.corners);}catch(reason){if(isViewportCoordinateError(reason))return null;throw reason;}
  const group=new THREE.Group();group.name="mesh-quality-selection";group.userData.elementId=cell.elementId;group.userData.viewportOrigin=local.origin;placeViewportObject(group,local.origin);
  const surface=new THREE.BufferGeometry();surface.setAttribute("position",new THREE.BufferAttribute(local.positions,3));surface.setIndex([0,2,1,0,1,3,1,2,3,2,0,3]);
  const faces=new THREE.Mesh(surface,new THREE.MeshBasicMaterial({color,opacity:.2,transparent:true,depthTest:false,depthWrite:false,side:THREE.DoubleSide}));faces.renderOrder=12;group.add(faces);
  const lines=[];for(const [a,b] of [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]])lines.push(...local.positions.slice(a*3,a*3+3),...local.positions.slice(b*3,b*3+3));
  const wire=new THREE.BufferGeometry();wire.setAttribute("position",new THREE.Float32BufferAttribute(lines,3));
  const edges=new THREE.LineSegments(wire,new THREE.LineBasicMaterial({color,depthTest:false,depthWrite:false}));edges.renderOrder=13;group.add(edges);
  const nodes=new THREE.BufferGeometry();nodes.setAttribute("position",new THREE.BufferAttribute(local.positions,3));
  const halo=new THREE.Points(nodes.clone(),new THREE.PointsMaterial({color:0xf8f9fb,size:9,sizeAttenuation:false,depthTest:false,depthWrite:false}));halo.renderOrder=14;group.add(halo);
  const points=new THREE.Points(nodes,new THREE.PointsMaterial({color,size:5,sizeAttenuation:false,depthTest:false,depthWrite:false}));points.renderOrder=15;group.add(points);
  return group;
}
export function createMeshQualityHighlight(cell:MeshQualityCell,threshold=.2,topology?:MeshQualitySelection['topology']) {
  // Numerical state is not invented for spatial samples.
  const color=topology||cell.invalid||cell.inverted?0xff6b63:cell.degenerate||(cell.quality??0)<threshold?0xffc247:0x63d0f2;
  const group=createTetraHighlight(cell,color);if(!group)return null;
  if(topology?.faceCornerSlots?.length===3&&new Set(topology.faceCornerSlots).size===3&&topology.faceCornerSlots.every(slot=>Number.isInteger(slot)&&slot>=0&&slot<4)){
    const face=new THREE.BufferGeometry();setViewportPositions(face,topology.faceCornerSlots.flatMap(slot=>cell.corners!.slice(slot*3,slot*3+3)),group.userData.viewportOrigin);
    const marker=new THREE.Mesh(face,new THREE.MeshBasicMaterial({color:0xffc247,opacity:.65,transparent:true,depthTest:false,depthWrite:false,side:THREE.DoubleSide}));marker.name='mesh-topology-common-face';marker.renderOrder=16;group.add(marker);
  }
  return group;
}
export function createMeshDiagnosticHighlight(selection:MeshQualitySelection){
  if(diagnosticSelectionProblem(selection))return null;
  if(!selection.spatial)return 'quality' in selection.cell?createMeshQualityHighlight(selection.cell,selection.threshold,selection.topology):null;
  const primary=createTetraHighlight(selection.cell,0xff6b63),peer=createTetraHighlight(selection.spatial.peer,0xffc247);
  if(!primary||!peer)return null;
  primary.name='mesh-spatial-primary';peer.name='mesh-spatial-peer';
  const group=new THREE.Group();group.name='mesh-quality-selection';group.userData.elementIds=[selection.cell.elementId,selection.spatial.peer.elementId];group.add(primary,peer);return group;
}
