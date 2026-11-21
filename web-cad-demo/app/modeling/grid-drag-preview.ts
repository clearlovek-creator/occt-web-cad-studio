import * as THREE from "three";
import { makeGridDragCommand, type GridDragKind } from "./grid-drag";
export function dragPreviewGeometry(kind: GridDragKind, preview: NonNullable<ReturnType<typeof makeGridDragCommand>>["preview"]) {
  const { width: w, depth: d, height: h } = preview, r = w / 2;
  const shape = kind.replace("surface-", "");
  if (shape === "box") return new THREE.BoxGeometry(w, d, h);
  if (shape === "rectangle") return new THREE.PlaneGeometry(w, d);
  if (shape === "disk") return new THREE.CircleGeometry(r, 48);
  if (shape === "sphere") return new THREE.SphereGeometry(r, 32, 20);
  if (shape === "torus") return new THREE.TorusGeometry(r, Math.min(h, r * .45), 16, 48);
  if (shape === "tube") {
    const ring = new THREE.Shape(); ring.absarc(0, 0, r, 0, Math.PI * 2, false);
    const hole = new THREE.Path(); hole.absarc(0, 0, r * .6, 0, Math.PI * 2, true); ring.holes.push(hole);
    const geometry = new THREE.ExtrudeGeometry(ring, { depth: h, bevelEnabled: false, curveSegments: 32 }); geometry.translate(0, 0, -h / 2); return geometry;
  }
  if (shape === "wedge") {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-w/2,-d/2,-h/2,w/2,-d/2,-h/2,w/2,d/2,-h/2,-w/2,d/2,-h/2,-w/2,-d/2,h/2,0,-d/2,h/2,0,d/2,h/2,-w/2,d/2,h/2],3));
    geometry.setIndex([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]); geometry.computeVertexNormals(); return geometry;
  }
  const geometry = new THREE.CylinderGeometry(shape === "cone" ? 0 : shape === "pyramid" ? r * .5 : r, r, h, shape === "prism" ? 6 : shape === "pyramid" ? 4 : 48, 1, kind.startsWith("surface-"));
  geometry.rotateX(Math.PI / 2);
  if (shape === "prism") geometry.rotateZ(Math.PI / 2);
  if (shape === "pyramid") { geometry.rotateZ(Math.PI / 4); geometry.scale(Math.SQRT2, d / w * Math.SQRT2, 1); }
  return geometry;
}
