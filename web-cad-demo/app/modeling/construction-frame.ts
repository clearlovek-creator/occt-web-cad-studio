import {makeGridDragCommand,type GridDragKind,type GridPoint} from "./grid-drag";

export type Vec3 = readonly [number,number,number];
export type ConstructionCoordinate = {id:string;name:string;origin:readonly number[];xAxis:readonly number[];yAxis:readonly number[];associationMode?:string;referenceState?:string};
export type ConstructionFrame = {id:string;name:string;origin:Vec3;x:Vec3;y:Vec3;z:Vec3;placementY:Vec3;legacyPlacement:boolean;signature:string};
export const GLOBAL_CONSTRUCTION_COORDINATE:ConstructionCoordinate={id:"global",name:"Global",origin:[0,0,0],xAxis:[1,0,0],yAxis:[0,1,0]};
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function vector(value:readonly number[]):Vec3 {
  if(value.length!==3 || value.some(v=>!Number.isFinite(v)))throw new Error("构造坐标系必须包含有限的三维原点与轴方向。");
  return [value[0],value[1],value[2]];
}
function unit(value:Vec3):Vec3 {
  const length=Math.hypot(...value);
  if(length<1e-12 || !Number.isFinite(length) || !Number.isFinite(dot(value,value)))throw new Error("构造坐标轴长度无效，请使用正常范围的非零方向。");
  return value.map(v=>v/length) as unknown as Vec3;
}
/** Match OCCT's orientation while retaining its historical placement convention:
 * native X/Z offsets use unit directions, but native Y offsets use the stored raw Y. */
export function constructionFrame(coordinate:ConstructionCoordinate):ConstructionFrame {
  if(coordinate.associationMode==="associative" && coordinate.referenceState!=="resolved")throw new Error("所选面坐标系引用失效，请重新关联有效面；不会使用旧位置绘制。");
  const origin=vector(coordinate.origin),rawX=vector(coordinate.xAxis),rawY=vector(coordinate.yAxis),x=unit(rawX),normalizedY=unit(rawY);
  if(Math.abs(dot(x,normalizedY))>.999999)throw new Error("构造坐标轴接近平行，无法确定可靠的建模平面。");
  const z=unit(cross(x,normalizedY)),y=unit(cross(z,x));
  return {id:coordinate.id,name:coordinate.name,origin,x,y,z,placementY:rawY,legacyPlacement:Math.abs(dot(rawY,x))>1e-9 || Math.abs(dot(rawY,y)-1)>1e-9,signature:JSON.stringify([coordinate.id,origin,rawX,rawY])};
}
export function constructionToWorld(frame:ConstructionFrame,point:Vec3):Vec3 {
  return frame.origin.map((v,i)=>v+frame.x[i]*point[0]+frame.y[i]*point[1]+frame.z[i]*point[2]) as unknown as Vec3;
}
export function worldToConstruction(frame:ConstructionFrame,point:Vec3):Vec3 {
  const relative=point.map((v,i)=>v-frame.origin[i]) as unknown as Vec3;
  return [dot(relative,frame.x),dot(relative,frame.y),dot(relative,frame.z)];
}
export function constructionDragCommand(kind:GridDragKind,start:GridPoint,end:GridPoint,step:number,height:number,frame:ConstructionFrame) {
  const command=makeGridDragCommand(kind,start,end,step,height);
  if(!command)return null;
  const scale=dot(frame.placementY,frame.y),skew=dot(frame.placementY,frame.x);
  const y=command.parameters.y/scale,x=command.parameters.x-skew*y;
  if(![x,y].every(Number.isFinite))throw new Error("坐标变换超出有效范围，未创建几何。");
  return {...command,parameters:{...command.parameters,x,y,coordinateSystemId:frame.id}};
}
export function snappedConstructionPoint(frame:ConstructionFrame,world:Vec3,step:number):Vec3 {
  if(!Number.isFinite(step)||step<=0)throw new Error("吸附步长必须为正数。");
  const point=worldToConstruction(frame,world);return [Math.round(point[0]/step)*step,Math.round(point[1]/step)*step,0];
}
export function dragDimension(value:number){return Number(value.toFixed(6)).toString();}
