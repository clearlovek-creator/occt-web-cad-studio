import * as THREE from 'three';
import type {PropertyTarget} from '../model/property-schema';
import {MAX_PROPERTY_TARGETS,propertyTargetKey} from '../../shared/property-targets.mjs';
import {setViewportPositions,placeViewportObject} from '../model/viewport-coordinates';
type Target=NonNullable<PropertyTarget>;
export type PropertyHighlightBody={bodyId:string;bodyIdentity?:string;topologyIdentity?:string;topologyRevision?:number;faceCount?:number;edgeCount?:number;visible?:boolean};
type Presentation={bodyId:string;positions:number[];normals:number[];indices:number[];triangleFaceIds:string[];edges:Array<{edgeId:string;points:number[]}>};

export function canonicalPropertyHighlightTargets(targets:Target[],bodies:PropertyHighlightBody[]):Target[] {
  if(targets.length>MAX_PROPERTY_TARGETS)throw new Error(`最多定位 ${MAX_PROPERTY_TARGETS} 个关联对象。`);
  const byId=new Map(bodies.map(body=>[body.bodyId,body]));
  const checked=targets.map((target):Target=>{
    const body=byId.get(target.bodyId);
    if(!['body','face','edge'].includes(target.kind))throw new Error('未知的属性关联类型。');
    if(!body||!body.bodyIdentity||target.bodyIdentity&&target.bodyIdentity!==body.bodyIdentity)throw new Error('关联 Body 已失效，未使用相同编号替代。');
    if(target.kind==='body')return {kind:'body',bodyId:body.bodyId,bodyIdentity:body.bodyIdentity};
    const match=new RegExp(`^${target.kind}-${body.topologyRevision}-([1-9][0-9]*)$`).exec(target.topologyId||''),count=target.kind==='face'?body.faceCount:body.edgeCount;
    if(!body.topologyIdentity||!Number.isSafeInteger(body.topologyRevision)||target.topologyIdentity&&target.topologyIdentity!==body.topologyIdentity||!match||target.topologyRevision!==undefined&&target.topologyRevision!==body.topologyRevision||!Number.isSafeInteger(count)||Number(match[1])>Number(count))throw new Error('关联面/边已失效，请重新读取属性关联。');
    return {...target,bodyIdentity:body.bodyIdentity,topologyIdentity:body.topologyIdentity,topologyRevision:body.topologyRevision};
  });
  return [...new Map(checked.map(target=>[propertyTargetKey(target),target])).values()];
}

/** Separate diagnostic overlay: never feeds topology picking or owns source GPU buffers. */
export function makePropertyHighlight(targets:Target[],bodies:PropertyHighlightBody[],presentations:Presentation[],color:number,emissive:number):THREE.Group {
  const checked=canonicalPropertyHighlightTargets(targets,bodies),metadata=new Map(bodies.map(body=>[body.bodyId,body])),byId=new Map(presentations.map(body=>[body.bodyId,body])),group=new THREE.Group();
  const faceTriangles=new Map<string,Map<string,number[]>>();
  group.name='property-association-highlight';let rendered=0;
  try{for(const target of checked){
    if(metadata.get(target.bodyId)?.visible===false)continue;
    const p=byId.get(target.bodyId);if(!p)throw new Error('关联几何显示未载入，未绘制不完整集合。');
    if(target.kind==='edge'){
      const edge=p.edges.find(edge=>edge.edgeId===target.topologyId);if(!edge)throw new Error('关联边没有完整显示数据。');
      if(edge.points.length<6||edge.points.length%3||!edge.points.every(Number.isFinite))throw new Error('关联边显示数据无效。');
      const points:number[]=[];for(let i=3;i<edge.points.length;i+=3)points.push(...edge.points.slice(i-3,i+3));
      const geometry=new THREE.BufferGeometry(),origin=setViewportPositions(geometry,points);const line=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color,depthTest:true,depthWrite:false}));placeViewportObject(line,origin);line.renderOrder=4;group.add(line);rendered++;continue;
    }
    const positions:number[]=[],normals:number[]=[];
    if(!faceTriangles.has(p.bodyId)){const map=new Map<string,number[]>();p.triangleFaceIds.forEach((id,index)=>{if(!map.has(id))map.set(id,[]);map.get(id)!.push(index);});faceTriangles.set(p.bodyId,map);}
    const triangles=target.kind==='face'?faceTriangles.get(p.bodyId)!.get(target.topologyId||'')||[]:p.triangleFaceIds.map((_,index)=>index);
    for(const triangle of triangles)for(let i=0;i<3;i++){const vertex=p.indices[triangle*3+i];if(!Number.isSafeInteger(vertex)||vertex<0||vertex*3+3>p.positions.length||vertex*3+3>p.normals.length)throw new Error('关联面显示数据索引无效。');positions.push(...p.positions.slice(vertex*3,vertex*3+3));normals.push(...p.normals.slice(vertex*3,vertex*3+3));}
    if(!positions.length||positions.length%9||positions.length!==normals.length||!positions.every(Number.isFinite)||!normals.every(Number.isFinite))throw new Error('关联面没有完整显示数据。');
    const geometry=new THREE.BufferGeometry(),origin=setViewportPositions(geometry,positions);geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
    const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color,emissive,transparent:true,opacity:.9,side:THREE.DoubleSide,depthTest:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));placeViewportObject(mesh,origin);mesh.renderOrder=3;group.add(mesh);rendered++;
  }}catch(error){group.traverse(object=>{if(object instanceof THREE.Mesh||object instanceof THREE.LineSegments){object.geometry.dispose();const materials=Array.isArray(object.material)?object.material:[object.material];materials.forEach(material=>material.dispose());}});throw error;}
  group.userData.renderedTargets=rendered;return group;
}
