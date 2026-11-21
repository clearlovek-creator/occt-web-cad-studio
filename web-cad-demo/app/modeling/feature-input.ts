import type {ModelingCommandInput, ModelingCommandResponse} from "./command-contract";

export type InputPresentation={bodyId:string;topologyRevision:number;positions:number[];normals:number[];indices:number[];triangleFaceIds:string[];edges:Array<{edgeId:string;points:number[]}>;stats:{faceCount:number;edgeCount:number;triangleCount:number;truncated?:boolean}};
export function validateSweepSourcePresentation(value:unknown,bodyId:string):InputPresentation {
  const p=value as InputPresentation;
  const numbers=(array:unknown,limit:number):array is number[]=>Array.isArray(array)&&array.length<=limit&&array.every(entry=>typeof entry==="number"&&Number.isFinite(entry));
  if(!p||p.bodyId!==bodyId||!Number.isSafeInteger(p.topologyRevision)||p.topologyRevision<0||!numbers(p.positions,900000)||p.positions.length%3||!numbers(p.normals,900000)||p.normals.length!==p.positions.length||!Array.isArray(p.indices)||p.indices.length>300000||p.indices.length%3||p.indices.some(index=>!Number.isSafeInteger(index)||index<0||index>=p.positions.length/3)||!Array.isArray(p.triangleFaceIds)||p.triangleFaceIds.length!==p.indices.length/3||p.triangleFaceIds.some(id=>!new RegExp(`^face-${p.topologyRevision}-[1-9]\\d*$`).test(id))||!Array.isArray(p.edges)||!p.edges.length||p.edges.length>5000||p.edges.some(edge=>!new RegExp(`^edge-${p.topologyRevision}-[1-9]\\d*$`).test(edge.edgeId)||!numbers(edge.points,3000)||edge.points.length<6||edge.points.length%3)||new Set(p.edges.map(edge=>edge.edgeId)).size!==p.edges.length||!p.stats||p.stats.truncated||p.stats.triangleCount!==p.triangleFaceIds.length||!Number.isSafeInteger(p.stats.faceCount)||p.stats.faceCount<0||!Number.isSafeInteger(p.stats.edgeCount)||p.stats.edgeCount!==p.edges.length)
    throw new Error("扫掠来源显示不完整、过大或身份不符，未允许拾取。请重新读取有效的 Body。");
  if(p.triangleFaceIds.some(id=>topologyIndex(id)>p.stats.faceCount)||p.edges.some(edge=>topologyIndex(edge.edgeId)>p.stats.edgeCount))throw new Error("扫掠来源拓扑编号超出显示范围，未允许拾取。");
  return p;
}
export type FeatureInputPreview={featureId:string;coordinateSystemId?:string;sectionId?:string;sweepInputId?:string;featureType:string;sourceBodyId:string;sourceBodyIdentity:string;sourceFeatureId:string;kind:"face"|"edge";inputFingerprint:string;selectionState:string;resolvedIndex:number;diagnostic:string;presentation:InputPresentation;requiredHoleCount?:number;selectedHoleIndexes?:number[];faceBoundaries?:{version:1;complete:boolean;faces:unknown[]}};
export type FeatureInputResponse=ModelingCommandResponse & {documentId:string;revision:number;stateToken:string;proposalOperation?:string;inputPreview:FeatureInputPreview};
export type ReferenceRepairTarget={targetFeatureId:string;targetSectionId?:string;targetSweepInputId?:string;targetCoordinateId?:never;sourceFeatureId?:string;sourceBodyId?:string}|{targetCoordinateId:string;targetFeatureId?:never;targetSectionId?:never;targetSweepInputId?:never;sourceFeatureId?:string;sourceBodyId?:string};
export type FeatureRepairProposal={request:ModelingCommandInput;documentId?:string;stateToken?:string}&ReferenceRepairTarget;
export type FeatureSelectionEdit={documentId:string;featureId:string;sectionId?:string;sweepInputId?:string;sourceBodyId:string;sourceBodyIdentity:string;sourceFeatureId:string;kind:"face"|"edge";inputFingerprint:string;index:number;holeIndexes?:number[]};
export type CoordinateSelectionEdit=Omit<FeatureSelectionEdit,"featureId">&{coordinateSystemId:string};

const finiteArray=(value:unknown,max:number)=>Array.isArray(value) && value.length<=max && value.every(entry=>typeof entry==="number" && Number.isFinite(entry));
const identifier=(value:unknown)=>typeof value==="string" && /^[A-Za-z0-9_-]{1,96}$/.test(value);
export function validateFeatureInput(value:FeatureInputResponse,documentId:string,featureId:string,expectedOperation?:string):FeatureInputResponse {
  const fail=():never=>{throw new Error("历史输入预览不完整或来源不符，未允许选取。请重新读取。");};
  if(!value?.ok || value.documentId!==documentId || !Number.isSafeInteger(value.revision) || value.revision<0 || !/^[a-f0-9]{64}$/.test(value.stateToken || ""))return fail();
  if(expectedOperation && value.proposalOperation!==expectedOperation)throw new Error("几何服务未按本次修改重建历史输入，请更新后台后重新读取，未允许选取。");
  const input=value.inputPreview,p=input?.presentation;
  if(!input || input.featureId!==featureId || typeof input.featureType!=="string" || typeof input.diagnostic!=="string" || !["resolved","unresolved","unverified"].includes(input.selectionState) || !identifier(input.sourceBodyId) || !identifier(input.sourceFeatureId) || !/^[a-f0-9]{32}$/.test(input.sourceBodyIdentity) || !/^[a-f0-9]{64}$/.test(input.inputFingerprint) || !["face","edge"].includes(input.kind))return fail();
  if(!p || p.bodyId!==input.sourceBodyId || p.topologyRevision!==0 || !finiteArray(p.positions,900000) || (!p.positions.length && !(input.sweepInputId && input.kind==="edge" && p.edges?.length)) || p.positions.length%3 || !finiteArray(p.normals,900000) || p.normals.length!==p.positions.length || !Array.isArray(p.indices) || p.indices.length>300000 || p.indices.length%3 || p.indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=p.positions.length/3))return fail();
  if(!Array.isArray(p.triangleFaceIds) || p.triangleFaceIds.length!==p.indices.length/3 || p.triangleFaceIds.some(id=>!/^face-0-[1-9]\d*$/.test(id)) || !Array.isArray(p.edges) || p.edges.length>5000 || p.edges.some(edge=>!/^edge-0-[1-9]\d*$/.test(edge.edgeId) || !finiteArray(edge.points,3000) || edge.points.length<6 || edge.points.length%3))return fail();
  if(!p.stats || (p.stats.truncated!==undefined && typeof p.stats.truncated!=="boolean") || !Number.isSafeInteger(p.stats.faceCount) || p.stats.faceCount<(input.sweepInputId && input.kind==="edge"?0:1) || !Number.isSafeInteger(p.stats.edgeCount) || p.stats.edgeCount<0 || p.stats.triangleCount!==p.triangleFaceIds.length || !Number.isSafeInteger(input.resolvedIndex) || input.resolvedIndex<0 || input.resolvedIndex>(input.kind==="face"?p.stats.faceCount:p.stats.edgeCount))return fail();
  if(new Set(p.edges.map(edge=>edge.edgeId)).size!==p.edges.length || p.triangleFaceIds.some(id=>topologyIndex(id)>p.stats.faceCount) || p.edges.some(edge=>topologyIndex(edge.edgeId)>p.stats.edgeCount))return fail();
  if(input.requiredHoleCount!==undefined&&(!input.sectionId||input.featureType!=='detail.loft'||!Number.isSafeInteger(input.requiredHoleCount)||input.requiredHoleCount<0||input.requiredHoleCount>16||!Array.isArray(input.selectedHoleIndexes)||input.selectedHoleIndexes.length!==input.requiredHoleCount||input.selectedHoleIndexes.some(index=>!Number.isSafeInteger(index)||index<0||index>p.stats.edgeCount)))return fail();
  if(input.faceBoundaries!==undefined){const table=input.faceBoundaries;if(!input.sectionId||table?.version!==1||typeof table.complete!=='boolean'||!Array.isArray(table.faces)||table.faces.length>5000||table.faces.some(face=>!face||typeof face!=='object'||!/^face-0-[1-9]\d*$/.test((face as {faceId?:string}).faceId||'')))return fail();}
  return value;
}
export function topologyIndex(id:string){return Number(id.slice(id.lastIndexOf("-")+1));}
export function featureSelectionEdit(response:FeatureInputResponse,index:number,holeIndexes?:number[]):FeatureSelectionEdit {
  const input=response.inputPreview,p=input.presentation;
  if(input.sweepInputId!==undefined && (!identifier(input.sweepInputId) || !["detail.sweep","detail.pipe"].includes(input.featureType) || input.kind!==(input.sweepInputId==="profile"?"face":"edge") || input.sectionId!==undefined || input.coordinateSystemId!==undefined))throw new Error("预览不是有效的曲线扫掠历史输入。");
  if(input.sectionId!==undefined && (!identifier(input.sectionId) || input.featureType!=="detail.loft" || input.kind!=="face" || input.coordinateSystemId!==undefined))throw new Error("预览不是有效的放样截面历史来源。");
  const rendered=new Set(input.kind==="face"?p.triangleFaceIds.map(topologyIndex):p.edges.map(edge=>topologyIndex(edge.edgeId)));
  if(p.stats.truncated || !Number.isSafeInteger(index) || !rendered.has(index))throw new Error("只能使用完整历史预览中实际显示的面或边。显示截断时不能提交重选。");
  if(holeIndexes!==undefined){const edges=new Set(p.edges.map(edge=>topologyIndex(edge.edgeId)));if(!input.sectionId||!Array.isArray(holeIndexes)||holeIndexes.length!==(input.requiredHoleCount??0)||holeIndexes.length>16||new Set(holeIndexes).size!==holeIndexes.length||holeIndexes.some(edge=>!Number.isSafeInteger(edge)||!edges.has(edge)))throw new Error('孔对应必须来自同一完整历史视图，每个孔使用不同的实际边。');}
  return {documentId:response.documentId,featureId:input.featureId,...(input.sectionId?{sectionId:input.sectionId}:{}),...(input.sweepInputId?{sweepInputId:input.sweepInputId}:{}),...(holeIndexes!==undefined?{holeIndexes}:{}),sourceBodyId:input.sourceBodyId,sourceBodyIdentity:input.sourceBodyIdentity,sourceFeatureId:input.sourceFeatureId,kind:input.kind,inputFingerprint:input.inputFingerprint,index};
}
export function inputEdgeSegments(edges:InputPresentation["edges"]){
  const positions:number[]=[],topology:number[]=[];
  for(const edge of edges)for(let point=3;point<edge.points.length;point+=3){positions.push(...edge.points.slice(point-3,point+3));topology.push(topologyIndex(edge.edgeId));}
  return {positions,topology};
}

export function featureInputRequest(proposal:FeatureRepairProposal):ModelingCommandInput {
  const inputs={...(proposal.targetCoordinateId?{coordinateSystemId:proposal.targetCoordinateId}:{featureId:proposal.targetFeatureId,...(proposal.targetSectionId?{sectionId:proposal.targetSectionId}:{}),...(proposal.targetSweepInputId?{sweepInputId:proposal.targetSweepInputId}:{})}),...(proposal.sourceFeatureId?{sourceFeatureId:proposal.sourceFeatureId}:{}),...(proposal.sourceBodyId?{sourceBodyId:proposal.sourceBodyId}:{})};
  return {operation:"feature.input.preview",inputs,parameters:{proposal:{operation:proposal.request.operation,inputs:proposal.request.inputs || {},parameters:proposal.request.parameters || {}}}};
}

export function validateReferenceInput(value:FeatureInputResponse,documentId:string,proposal:FeatureRepairProposal):FeatureInputResponse {
  if(!proposal.targetCoordinateId){
    if(!proposal.targetFeatureId)throw new Error("请选择需要修复的特征或坐标系。");
    if(value?.inputPreview?.coordinateSystemId!==undefined)throw new Error("预览引用对象不符，不能把坐标系来源当作特征输入。");
    const input=value?.inputPreview;
    if(proposal.targetSweepInputId){
      if(proposal.targetSectionId || !identifier(proposal.targetSweepInputId) || input?.sweepInputId!==proposal.targetSweepInputId || !["detail.sweep","detail.pipe"].includes(input.featureType) || input.kind!==(proposal.targetSweepInputId==="profile"?"face":"edge") || input.sectionId!==undefined
        || (proposal.sourceFeatureId && input.sourceFeatureId!==proposal.sourceFeatureId) || (proposal.sourceBodyId && input.sourceBodyId!==proposal.sourceBodyId))throw new Error("曲线扫掠历史输入来源不符，未允许选取。");
      return validateFeatureInput(value,documentId,proposal.targetFeatureId,proposal.request.operation);
    }else if(input?.sweepInputId!==undefined)throw new Error("预览引用对象不符，不能把曲线输入当作其他特征输入。");
    if(proposal.targetSectionId){
      if(!identifier(proposal.targetSectionId) || input?.sectionId!==proposal.targetSectionId || input?.featureType!=="detail.loft" || input.kind!=="face"
        || (proposal.sourceFeatureId && input.sourceFeatureId!==proposal.sourceFeatureId) || (proposal.sourceBodyId && input.sourceBodyId!==proposal.sourceBodyId))
        throw new Error("放样截面历史来源不符，未允许选面。请重新读取。");
    }else if(input?.sectionId!==undefined)throw new Error("预览引用对象不符，不能把放样截面当作其他特征输入。");
    return validateFeatureInput(value,documentId,proposal.targetFeatureId,proposal.request.operation);
  }
  const input=value?.inputPreview;
  if(!input || input.sectionId!==undefined || input.sweepInputId!==undefined || input.coordinateSystemId!==proposal.targetCoordinateId || input.kind!=="face" || input.featureType!=="coordinate.face"
    || input.featureId!==input.sourceFeatureId || (proposal.sourceFeatureId && input.sourceFeatureId!==proposal.sourceFeatureId)
    || (proposal.sourceBodyId && input.sourceBodyId!==proposal.sourceBodyId))throw new Error("坐标系历史来源不符，未允许选面。请重新读取。");
  return validateFeatureInput(value,documentId,input.featureId,proposal.request.operation);
}

export function coordinateSelectionEdit(response:FeatureInputResponse,index:number):CoordinateSelectionEdit {
  const {coordinateSystemId,featureType}=response.inputPreview;
  if(!identifier(coordinateSystemId) || featureType!=="coordinate.face" || response.inputPreview.kind!=="face" || response.inputPreview.sectionId!==undefined)throw new Error("预览不是有效的面坐标系历史来源。");
  const edit=featureSelectionEdit(response,index);
  return {coordinateSystemId:coordinateSystemId!,documentId:edit.documentId,sourceBodyId:edit.sourceBodyId,sourceBodyIdentity:edit.sourceBodyIdentity,sourceFeatureId:edit.sourceFeatureId,kind:"face",inputFingerprint:edit.inputFingerprint,index:edit.index};
}

export function sweepInputSlots(feature:{stringParameters?:Record<string,string>}|undefined):Array<{inputId:string;kind:"face"|"edge";bodyId:string;featureId:string;label:string}> {
  if(feature?.stringParameters?.sweepVersion!=="2")return [];
  try{const profile=JSON.parse(feature.stringParameters.sweepProfile),path=JSON.parse(feature.stringParameters.sweepPath);
    return [{inputId:"profile",kind:"face",bodyId:profile.bodyId,featureId:profile.featureId,label:"截面"},...path.edges.map((edge:{inputId?:string},index:number)=>({inputId:edge.inputId||`legacy-path-${index+1}`,kind:"edge" as const,bodyId:path.bodyId,featureId:path.featureId,label:`路径边 ${index+1}`}))];
  }catch{return [];}
}

export function changeRepairSource(proposal:FeatureRepairProposal,sourceFeatureId:string,sourceBodyId:string):FeatureRepairProposal {
  const parameters={...proposal.request.parameters};
  if(proposal.targetSweepInputId && proposal.targetSweepInputId!=="profile" && Array.isArray(parameters.selectionEdits))
    parameters.selectionEdits=(parameters.selectionEdits as FeatureSelectionEdit[]).filter(edit=>edit.featureId!==proposal.targetFeatureId || !edit.sweepInputId || edit.sweepInputId==="profile");
  return {...proposal,sourceFeatureId,sourceBodyId,request:{...proposal.request,parameters}};
}
