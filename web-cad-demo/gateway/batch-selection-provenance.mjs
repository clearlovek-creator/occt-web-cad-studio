/** Only server-observed native snapshots may qualify a batch selection.
 * A literal ID belongs to the entry snapshot; a $ref belongs to its producer. */
function fail(path, reason) {
  throw Object.assign(new Error(`批内几何选择已失效（${path}）：${reason}。请引用产生该几何的步骤结果，或重新读取工程并选择；整批不会部分提交。`),
    {code:"BATCH_SELECTION_STALE",fieldPath:path});
}
function observation(raw, root, observations, path) {
  if(raw && typeof raw==="object" && typeof raw.$ref==="string") {
    const source=observations.get(raw.$ref.split(".")[0]);
    if(!source)fail(path,"来源步骤没有可核验的几何快照");
    return source;
  }
  return root;
}
function identity(view, bodyId) {
  if(!Array.isArray(view?.bodyMetadata) || !view.bodyMetadata.some(body=>body.bodyId===bodyId))return null;
  return view.entityIdentities?.[bodyId] || null;
}
function checkBody(rawId, bodyId, root, observations, current, path, topology=false) {
  const expected=identity(observation(rawId,root,observations,path),bodyId),actual=identity(current,bodyId);
  if(!expected?.bodyIdentity || !actual?.bodyIdentity || expected.bodyIdentity!==actual.bodyIdentity)
    fail(path,"Body 已被删除、替换或不属于该来源快照");
  if(topology && (!expected.topologyIdentity || expected.topologyIdentity!==actual.topologyIdentity))
    fail(path,"拓扑已在前序步骤中改变，旧面/边编号不能再次使用");
}
function checkTarget(raw, target, root, observations, current, path) {
  if(!target || !["body","face","edge"].includes(target.kind))return;
  const wholeReference=raw && typeof raw==="object" && typeof raw.$ref==="string";
  checkBody(wholeReference?raw:raw?.bodyId,target.bodyId,root,observations,current,path+".bodyId");
  if(target.kind!=="body")checkBody(wholeReference?raw:raw?.topologyId,target.bodyId,root,observations,current,path+".topologyId",true);
}
function sameCoordinate(view, current, id) {
  const before=view?.coordinateSystems?.find(item=>item.id===id),after=current.coordinateSystems?.find(item=>item.id===id);
  if(!before || !after || JSON.stringify(before)!==JSON.stringify(after))return false;
  if(before.associationMode!=="associative")return true;
  const a=view.features?.find(item=>item.id===before.referenceFeatureId),b=current.features?.find(item=>item.id===after.referenceFeatureId);
  return Boolean(a?.identity && a.identity===b?.identity
    && view.entityIdentities?.[before.referenceBodyId]?.bodyIdentity===current.entityIdentities?.[after.referenceBodyId]?.bodyIdentity);
}
export function validateBatchSelectionProvenance(operation, raw, resolved, root, observations, current) {
  const inputs=resolved.inputs || {},parameters=resolved.parameters || {},rawInputs=raw.inputs || {},rawParameters=raw.parameters || {};
  if(["detail.sweep","detail.pipe"].includes(operation) && inputs.pathEdgeIds){
    checkBody(rawInputs.pathBodyId,inputs.pathBodyId,root,observations,current,"inputs.pathBodyId");
    inputs.pathEdgeIds.forEach((edge,index)=>checkBody(rawInputs.pathEdgeIds?.$ref?rawInputs.pathEdgeIds:rawInputs.pathEdgeIds?.[index],inputs.pathBodyId,root,observations,current,`inputs.pathEdgeIds.${index}`,true));
  }
  if(operation==="feature.update" && parameters.sweepDefinition){
    const definition=parameters.sweepDefinition,rawDefinition=rawParameters.sweepDefinition;
    for(const role of ["profile","path"]){const selection=definition[role];if(!selection)continue;const entry=rawDefinition?.$ref?rawDefinition:rawDefinition?.[role];const field=role==="profile"?"faceId":"edgeIds",prefix=`parameters.sweepDefinition.${role}`;
      checkBody(entry?.$ref?entry:entry?.bodyId,selection.bodyId,root,observations,current,prefix+".bodyId");
      if(role==="path"&&Array.isArray(selection.edgeIds))selection.edgeIds.forEach((edge,index)=>checkBody(entry?.$ref?entry:entry?.edgeIds?.$ref?entry.edgeIds:entry?.edgeIds?.[index],selection.bodyId,root,observations,current,prefix+`.edgeIds.${index}`,true));
      else checkBody(entry?.$ref?entry:entry?.[field],selection.bodyId,root,observations,current,prefix+'.'+field,true);
    }
  }
  const sections=operation==="detail.loft"?inputs.sections:operation==="feature.update"?parameters.loftDefinition?.sections:null;
  const rawSections=operation==="detail.loft"?rawInputs.sections:rawParameters.loftDefinition?.$ref?rawParameters.loftDefinition:rawParameters.loftDefinition?.sections;
  if(Array.isArray(sections))sections.forEach((section,index)=>{
    if(section?.sectionId)return; // Native historical proof, not a fresh live Face ID.
    const path=operation==="detail.loft"?`inputs.sections.${index}`:`parameters.loftDefinition.sections.${index}`;
    const entry=rawSections?.$ref?rawSections:rawSections?.[index],whole=entry?.$ref;
    checkBody(whole?entry:entry?.bodyId,section?.bodyId,root,observations,current,path+".bodyId");
    checkBody(whole?entry:entry?.faceId,section?.bodyId,root,observations,current,path+".faceId",true);
    if(Array.isArray(section?.holeEdgeIds))section.holeEdgeIds.forEach((_edge,edgeIndex)=>checkBody(whole?entry:entry?.holeEdgeIds?.$ref?entry.holeEdgeIds:entry?.holeEdgeIds?.[edgeIndex],section.bodyId,root,observations,current,path+`.holeEdgeIds.${edgeIndex}`,true));
  });
  if(operation.startsWith("detail."))for(const kind of ["face","edge"]){
    if(!inputs[`${kind}Id`])continue;
    if(!inputs.bodyId)fail("inputs.bodyId","批内面/边操作必须显式指定 Body");
    checkBody(rawInputs.bodyId,inputs.bodyId,root,observations,current,"inputs.bodyId");
    checkBody(rawInputs[`${kind}Id`],inputs.bodyId,root,observations,current,`inputs.${kind}Id`,true);
  }
  if(operation==="coordinate.set" && parameters.kind==="face"){
    if(parameters.preserveReference || parameters.copyReferenceFrom){
      const field=parameters.copyReferenceFrom?"copyReferenceFrom":"id",id=parameters[field];
      if(!sameCoordinate(observation(rawParameters[field],root,observations,"parameters."+field),current,id))fail("parameters."+field,"来源坐标系已在前序步骤中改变或被替换");
    }else{
      checkBody(rawParameters.referenceBodyId,parameters.referenceBodyId,root,observations,current,"parameters.referenceBodyId");
      checkBody(rawParameters.referenceTopologyId,parameters.referenceBodyId,root,observations,current,"parameters.referenceTopologyId",true);
    }
  }
  if(["property.set","property.delete"].includes(operation))checkTarget(rawInputs,inputs,root,observations,current,"inputs");
  if(["property.instance.create","property.instance.update","property.instance.retarget"].includes(operation)){
    const inParameters=Object.hasOwn(parameters,"target");
    checkTarget(inParameters?rawParameters.target:rawInputs.target,inParameters?parameters.target:inputs.target,root,observations,current,inParameters?"parameters.target":"inputs.target");
    const collection=Object.hasOwn(parameters,'targets'),targets=collection?parameters.targets:inputs.targets,rawTargets=collection?rawParameters.targets:rawInputs.targets,prefix=collection?'parameters.targets':'inputs.targets';
    if(Array.isArray(targets))targets.forEach((target,index)=>checkTarget(rawTargets?.$ref?rawTargets:rawTargets?.[index],target,root,observations,current,`${prefix}.${index}`));
  }
  // Historical selectionEdits carry document/body/fingerprint proof and are
  // resolved by the native historical-input validator, not against live Bodies.
}
