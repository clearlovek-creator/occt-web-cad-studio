import {normalizeMeshSizing,meshSizingTargetCurrent,meshSizingTargetKey,type MeshSizing,type MeshSizingTarget} from '../../shared/mesh-sizing.mjs';
export type MeshSizingDraft={documentId:string;enabled:boolean;globalSize:string;rules:{id:string;size:string;name:string;target:MeshSizingTarget;transitionDistance?:string}[]};
type Body={bodyId:string;name?:string;bodyIdentity:string;topologyIdentity:string;topologyRevision:number};
const bodies=(view:unknown)=>((view as {bodyMetadata?:Body[]})?.bodyMetadata||[]);
export const emptyMeshSizingDraft=(documentId:string):MeshSizingDraft=>({documentId,enabled:false,globalSize:'',rules:[]});
export function meshSizingDraftFromTask(documentId:string,sizing:MeshSizing,view:unknown):MeshSizingDraft{
  const value=normalizeMeshSizing(sizing)!;return {documentId,enabled:true,globalSize:String(value.globalSize),rules:value.rules.map(rule=>({id:rule.id,size:String(rule.size),target:rule.target,...(rule.transitionDistance!==undefined?{transitionDistance:String(rule.transitionDistance)}:{}),name:bodies(view).find(body=>body.bodyId===rule.target.bodyId&&body.bodyIdentity===rule.target.bodyIdentity)?.name||rule.target.bodyId}))};
}
export function captureSizingTarget(view:unknown,bodyId:string|null|undefined,cadFaceId?:string|null){
  const body=bodies(view).find(body=>body.bodyId===bodyId);if(!body)throw Error('请先在当前工程中选择一个 Body。');
  const target:MeshSizingTarget={kind:cadFaceId?'face':'body',bodyId:body.bodyId,bodyIdentity:body.bodyIdentity,topologyIdentity:body.topologyIdentity,topologyRevision:body.topologyRevision,...(cadFaceId?{cadFaceId}:{})};
  normalizeMeshSizing({version:1,globalSize:1,rules:[{id:'target-check',size:1,target}]});
  return {target,name:body.name||body.bodyId};
}
export function meshSizingFromDraft(draft:MeshSizingDraft,documentId:string,view:unknown):MeshSizing|undefined{
  if(draft.documentId!==documentId||!draft.enabled)return undefined;
  if(draft.rules.some(rule=>!meshSizingTargetCurrent(rule.target,view)))throw Error('局部尺寸目标已变化，请重选或删除失效规则。');
  return normalizeMeshSizing({version:1,globalSize:Number(draft.globalSize.trim()),rules:draft.rules.map(rule=>({id:rule.id,size:Number(rule.size.trim()),target:rule.target,...(rule.transitionDistance?.trim()?{transitionDistance:Number(rule.transitionDistance.trim())}:{})}))});
}
export function updateSizingTarget(draft:MeshSizingDraft,id:string|null,captured:ReturnType<typeof captureSizingTarget>,newId:string):MeshSizingDraft{
  if(draft.rules.some(rule=>rule.id!==id&&meshSizingTargetKey(rule.target)===meshSizingTargetKey(captured.target)))throw Error('该体或面已有局部尺寸规则，请修改原规则。');
  if(id)return {...draft,rules:draft.rules.map(rule=>rule.id===id?{...rule,...captured}:rule)};
  return {...draft,rules:[...draft.rules,{id:newId,size:'',...captured}]};
}
