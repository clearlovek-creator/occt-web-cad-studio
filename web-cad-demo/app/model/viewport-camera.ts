import * as THREE from "three";

export type ViewportCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
export type ViewportProjection = "perspective" | "orthographic";
export type ViewportDisplay = "edges" | "shaded" | "wire";
export const viewportFov = 38;
export const bodyLayer = 1;
export const edgeLayer = 2;
const fallbackWireLayer = 3;

function perspectiveHeight(distance: number, fov = viewportFov) {
  return 2 * distance * Math.tan(THREE.MathUtils.degToRad(fov) / 2);
}

export function viewportViewHeight(camera: ViewportCamera, distance: number) {
  return (camera instanceof THREE.OrthographicCamera ? camera.top - camera.bottom : perspectiveHeight(distance, camera.fov)) / camera.zoom;
}

export function setViewportFrustum(camera: ViewportCamera, aspect: number, distance?: number) {
  if (distance !== undefined) camera.zoom = 1;
  if (camera instanceof THREE.OrthographicCamera) {
    if (distance !== undefined) {
      camera.top = perspectiveHeight(distance) / 2;
      camera.bottom = -camera.top;
    }
    camera.right = camera.top * aspect;
    camera.left = -camera.right;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}

export function visibleViewportBounds(object: THREE.Object3D) {
  const bounds = new THREE.Box3();
  const worldBounds = new THREE.Box3();
  object.updateWorldMatrix(true, true);
  object.traverseVisible(child => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points)) return;
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
    const local = child.geometry.boundingBox;
    if (local && !local.isEmpty()) bounds.union(worldBounds.copy(local).applyMatrix4(child.matrixWorld));
  });
  return bounds;
}

export function viewportFitDistance(box: THREE.Box3, direction: THREE.Vector3, up: THREE.Vector3, aspect: number, fov = viewportFov) {
  const basis = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), up);
  const right = new THREE.Vector3().setFromMatrixColumn(basis, 0);
  const vertical = new THREE.Vector3().setFromMatrixColumn(basis, 1);
  const towardCamera = new THREE.Vector3().setFromMatrixColumn(basis, 2);
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(.5);
  const tangent = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  const corner = new THREE.Vector3();
  let distance = 0;
  for (const x of [-half.x, half.x]) for (const y of [-half.y, half.y]) for (const z of [-half.z, half.z]) {
    corner.set(x, y, z);
    distance = Math.max(distance, corner.dot(towardCamera) + 1.12 * Math.max(Math.abs(corner.dot(right)) / aspect, Math.abs(corner.dot(vertical))) / tangent);
  }
  return distance;
}

export function changeViewportProjection(camera: ViewportCamera, projection: ViewportProjection, target: THREE.Vector3, aspect: number): ViewportCamera {
  const distance = camera.position.distanceTo(target);
  const height = viewportViewHeight(camera, distance);
  const next = projection === "orthographic"
    ? new THREE.OrthographicCamera(-height * aspect / 2, height * aspect / 2, height / 2, -height / 2, camera.near, camera.far)
    : new THREE.PerspectiveCamera(viewportFov, aspect, camera.near, camera.far);
  next.position.copy(camera.position);
  next.quaternion.copy(camera.quaternion);
  next.up.copy(camera.up);
  next.layers.mask = camera.layers.mask;
  if (next instanceof THREE.PerspectiveCamera) next.zoom = perspectiveHeight(distance) / height;
  next.updateProjectionMatrix();
  next.updateMatrixWorld(true);
  return next;
}

export function setViewportDisplay(camera: ViewportCamera, mode: ViewportDisplay, pickingEdges = false) {
  if (mode === "wire") camera.layers.disable(bodyLayer);
  else camera.layers.enable(bodyLayer);
  if (mode === "shaded" && !pickingEdges) camera.layers.disable(edgeLayer);
  else camera.layers.enable(edgeLayer);
  if (mode === "wire") camera.layers.enable(fallbackWireLayer);
  else camera.layers.disable(fallbackWireLayer);
}

export function setBodyDisplay(mesh: THREE.Mesh, mode: ViewportDisplay) {
  const fallback = Boolean(mesh.userData.viewportWireFallback);
  if (fallback) mesh.layers.enable(fallbackWireLayer);
  else mesh.layers.disable(fallbackWireLayer);
  const material = mesh.material as THREE.MeshStandardMaterial;
  material.wireframe = fallback && mode === "wire";
}
