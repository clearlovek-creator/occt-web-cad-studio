import * as THREE from "three";
import { opaqueViewportBodies, pickViewportBody } from "../model/viewport-picking";
import type { ViewportCamera } from "../model/viewport-camera";
import { worldToConstruction, type ConstructionFrame, type Vec3 } from "./construction-frame";
import type { GeometrySnapKind, GridPoint } from "./grid-drag";

export type EdgeSnapPoints = { endpoints: Vec3[]; midpoint?: Vec3 };
type Candidate = { line: THREE.Line; world: THREE.Vector3; point: GridPoint & { snap: GeometrySnapKind } };
const aperture = 9;

export function constructionSnapCandidates(lines: THREE.Line[], frame: ConstructionFrame): Candidate[] {
  const candidates: Candidate[] = [];
  for (const line of lines) {
    const snap = line.userData.snap as EdgeSnapPoints | undefined;
    if (!snap) continue;
    const add = (point: Vec3, kind: GeometrySnapKind) => {
      if (point.length !== 3 || !point.every(Number.isFinite)) return;
      const [x, y, z] = worldToConstruction(frame, point);
      // Accommodate floating-point subtraction at large engineering origins.
      const tolerance = Math.max(1e-6, 32 * Number.EPSILON * Math.max(...point.map(Math.abs), ...frame.origin.map(Math.abs)));
      if (Math.abs(z) <= tolerance) candidates.push({ line, world: new THREE.Vector3(...point), point: { x, y, snap: kind } });
    };
    for (const endpoint of snap.endpoints) add(endpoint, "endpoint");
    if (snap.midpoint) add(snap.midpoint, "midpoint");
  }
  return candidates;
}

export function pickConstructionSnap(candidates: Candidate[], mouse: THREE.Vector2, width: number, height: number, camera: ViewportCamera, meshes: THREE.Mesh[]): GridPoint | null {
  const hits: { candidate: Candidate; ndc: THREE.Vector2; distance: number; depth: number }[] = [];
  const projected = new THREE.Vector3();
  for (const candidate of candidates) {
    if (!candidate.line.visible) continue;
    projected.copy(candidate.world).project(camera);
    if (Math.max(Math.abs(projected.x), Math.abs(projected.y), Math.abs(projected.z)) > 1) continue;
    const distance = Math.hypot((mouse.x - projected.x) * width / 2, (mouse.y - projected.y) * height / 2);
    if (distance <= aperture) hits.push({ candidate, ndc: new THREE.Vector2(projected.x, projected.y), distance, depth: projected.z });
  }
  if (!hits.length) return null;
  hits.sort((a,b) => a.distance - b.distance || Number(a.candidate.point.snap === "midpoint") - Number(b.candidate.point.snap === "midpoint") || a.depth - b.depth);
  const occluders = opaqueViewportBodies(meshes).filter(mesh => camera.layers.test(mesh.layers) && !(mesh.material as THREE.MeshStandardMaterial).wireframe);
  const ray = new THREE.Raycaster();
  ray.layers.enableAll();
  for (const hit of hits) {
    ray.setFromCamera(hit.ndc, camera);
    const front = pickViewportBody(ray, occluders, camera);
    const distance = ray.ray.origin.distanceTo(hit.candidate.world);
    const tolerance = Math.max(1e-6, 8 * Number.EPSILON * distance);
    if (!front || front.distance + tolerance >= distance) return hit.candidate.point;
  }
  return null;
}
