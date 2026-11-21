import * as THREE from 'three';
export type ViewportOrigin=readonly [number,number,number];
export type LocalViewportPositions={positions:Float32Array;origin:ViewportOrigin};
function invalid(message:string){return Object.assign(Error(message),{code:'VIEWPORT_COORDINATES_INVALID'});}
/** Render-only anchoring. The engineering coordinates and source arrays remain
 * binary64; only differences from the anchor enter the float32 GPU buffer. */
export function localizeCoordinateValues(count:number,at:(index:number)=>number,anchor?:ViewportOrigin):LocalViewportPositions{
  if(!Number.isSafeInteger(count)||count<0||count%3)throw invalid('显示坐标数量无效。');
  const origin:ViewportOrigin=anchor?[...anchor]:count?[at(0),at(1),at(2)]:[0,0,0];
  if(origin.length!==3||!origin.every(Number.isFinite))throw invalid('显示坐标原点不是有限数值。');
  let positions:Float32Array;
  try{positions=new Float32Array(count);}catch{throw invalid('显示坐标缓冲区超过可分配资源。');}
  for(let i=0;i<count;i++){
    const value=at(i);if(!Number.isFinite(value))throw invalid('显示坐标包含非有限数值。');
    positions[i]=value-origin[i%3];if(!Number.isFinite(positions[i]))throw invalid('几何局部跨度超出当前视口范围，工程数据未修改。');
  }
  return {positions,origin};
}
export function localizePositions(values:ArrayLike<number>,anchor?:ViewportOrigin){return localizeCoordinateValues(values.length,i=>values[i],anchor);}
export function setViewportPositions(geometry:THREE.BufferGeometry,values:ArrayLike<number>,anchor?:ViewportOrigin):ViewportOrigin{
  const local=localizePositions(values,anchor);geometry.setAttribute('position',new THREE.BufferAttribute(local.positions,3));geometry.userData.viewportOrigin=local.origin;return local.origin;
}
export function placeViewportObject(object:THREE.Object3D,origin:ViewportOrigin){object.position.set(...origin);}
export function isViewportCoordinateError(error:unknown):error is Error{return error instanceof Error&&(error as Error&{code?:string}).code==='VIEWPORT_COORDINATES_INVALID';}
/** Fit microscopic but valid parts too; a one-unit camera floor hides them. */
export function viewportSpan(value:number){if(!Number.isFinite(value)||value<0)throw invalid('显示包围盒范围无效。');return value>0?Math.max(value,1e-6):1;}
/** Keep navigation limits in the part's scale, inside the fitted clip range. */
export function viewportOrbitLimits(value:number){const span=viewportSpan(value);return {minDistance:Math.max(1e-12,span/10000),maxDistance:span*50};}
