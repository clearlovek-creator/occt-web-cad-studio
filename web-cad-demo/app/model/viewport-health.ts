import * as THREE from "three";

/** Measure real scene membership, not cached Body IDs or tree rows. */
export function viewportHealth(scene: THREE.Scene, camera: THREE.Camera, bodies: THREE.Mesh[]) {
  const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  let attached=0,visible=0,inFrustum=0;
  for(const body of bodies) {
    let current: THREE.Object3D | null=body, shown=true;
    while(current && current!==scene){shown=shown && current.visible;current=current.parent;}
    if(current!==scene)continue;attached++;if(!shown)continue;visible++;
    if(frustum.intersectsObject(body))inFrustum++;
  }
  return {attached,visible,inFrustum};
}
