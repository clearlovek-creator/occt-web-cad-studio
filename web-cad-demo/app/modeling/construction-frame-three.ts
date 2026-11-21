import * as THREE from "three";
import type {ConstructionFrame} from "./construction-frame";

export function createConstructionGrid() {
  const grid = new THREE.GridHelper();
  const positions: number[] = [], colors: number[] = [];
  const major = new THREE.Color(0xa0b4cc), minor = new THREE.Color(0xc5d3e4);
  const halfSize = 600, spacing = 10, segmentLength = 30;
  for (let offset = -halfSize; offset <= halfSize; offset += spacing) {
    const { r, g, b } = offset % 50 === 0 ? major : minor;
    for (let start = -halfSize; start < halfSize; start += segmentLength) {
      const end = start + segmentLength;
      positions.push(start, 0, offset, end, 0, offset, offset, 0, start, offset, 0, end);
      colors.push(r, g, b, r, g, b, r, g, b, r, g, b);
    }
  }
  grid.geometry.dispose();
  grid.geometry = new THREE.BufferGeometry()
    .setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
    .setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return grid;
}

export function constructionMatrix(frame:ConstructionFrame) {
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.x),new THREE.Vector3(...frame.y),new THREE.Vector3(...frame.z)).setPosition(...frame.origin);
}
export function alignConstructionGrid(grid:THREE.GridHelper,frame:ConstructionFrame|null,visible:boolean) {
  grid.visible=Boolean(frame)&&visible;
  if(!frame)return;
  grid.quaternion.setFromRotationMatrix(constructionMatrix(frame)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2));
  grid.position.set(...frame.origin).addScaledVector(new THREE.Vector3(...frame.z),-.08);
}
