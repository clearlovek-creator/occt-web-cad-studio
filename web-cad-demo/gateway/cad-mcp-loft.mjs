import {loftHoleLimits,LOFT_HOLES_CAPABILITY,WorkerCapabilityError} from './worker-capabilities.mjs';
const face={type:'string',pattern:'^face-[0-9]+-[1-9][0-9]*$'},edge={type:'string',pattern:'^edge-[0-9]+-[1-9][0-9]*$'};
export function loftSectionsSchema(capabilities,{retained=false}={}){
  const limits=loftHoleLimits(capabilities),section={type:'object',properties:{bodyId:{type:'string',minLength:1,maxLength:96},faceId:face,...(limits?{holeEdgeIds:{type:'array',minItems:1,maxItems:limits.maxHolesPerSection,uniqueItems:true,items:edge}}:{})},required:['bodyId','faceId'],additionalProperties:false};
  return {type:'array',minItems:2,maxItems:limits?.maxSections||32,items:retained?{anyOf:[section,{type:'object',properties:{sectionId:{type:'string',minLength:1,maxLength:96}},required:['sectionId'],additionalProperties:false}]}:section};
}
export function loftDefinitionSchema(capabilities){return {type:'object',properties:{sections:loftSectionsSchema(capabilities,{retained:true}),placement:{type:'string',enum:['actual','z-spacing']},ruled:{type:'boolean'},sectionSpacing:{anyOf:[{type:'number'},{type:'string'}]}},additionalProperties:false};}
function fail(path,message){throw Object.assign(new Error(message),{code:'MCP_LOFT_DEFINITION_INVALID',fieldPath:path,retryableByModel:true});}
export function validateLoftSections(sections,{retained=false,path='inputs.sections'}={}){
  if(!Array.isArray(sections)||sections.length<2||sections.length>32)fail(path,'Provide 2–32 ordered real Face sections.');
  const counts=[];let holes=false;
  for(const [index,section] of sections.entries()){
    const location=`${path}.${index}`;
    if(!section||typeof section!=='object'||Array.isArray(section))fail(location,'A section must be an object.');
    if(retained&&Object.hasOwn(section,'sectionId')){if(Object.keys(section).length!==1||typeof section.sectionId!=='string'||!section.sectionId||section.sectionId.length>96)fail(location,'A retained section contains only its saved sectionId.');continue;}
    if(Object.keys(section).some(key=>!['bodyId','faceId','holeEdgeIds'].includes(key))||typeof section.bodyId!=='string'||!section.bodyId||section.bodyId.length>96||typeof section.faceId!=='string'||!/^face-\d+-[1-9]\d*$/.test(section.faceId))fail(location,'A new section requires an observed bodyId and faceId, optionally ordered holeEdgeIds.');
    const values=section.holeEdgeIds;
    if(Object.hasOwn(section,'holeEdgeIds')){
      if(!Array.isArray(values)||values.length<1||values.length>16||values.some(value=>typeof value!=='string'||!/^edge-\d+-[1-9]\d*$/.test(value))||new Set(values).size!==values.length)fail(location+'.holeEdgeIds','Map each inner loop once using 1–16 distinct observed Edge IDs; an empty mapping never means fill the holes.');
      holes=true;
    }
    counts.push(values?.length||0);
  }
  if(new Set(counts).size>1)fail(path,'Every newly supplied section must have the same explicit hole count. Retained sections are checked by the native kernel.');
  return holes;
}
export function validateLoftDefinition(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['sections','placement','ruled','sectionSpacing'].includes(key)))fail('parameters.loftDefinition','Unknown or invalid Loft definition fields.');
  if(value.placement!==undefined&&!['actual','z-spacing'].includes(value.placement))fail('parameters.loftDefinition.placement','Use actual or z-spacing placement.');
  if(value.ruled!==undefined&&typeof value.ruled!=='boolean')fail('parameters.loftDefinition.ruled','ruled must be boolean.');
  if(value.sectionSpacing!==undefined&&!(typeof value.sectionSpacing==='string'&&value.sectionSpacing.trim()||typeof value.sectionSpacing==='number'&&Number.isFinite(value.sectionSpacing)))fail('parameters.loftDefinition.sectionSpacing','Keep a finite number or a nonempty unit/variable expression.');
  return value.sections===undefined?false:validateLoftSections(value.sections,{retained:true,path:'parameters.loftDefinition.sections'});
}
/** A bounded read of existing health; old/unknown/offline services stay unproven. */
export async function readMcpNativeCapabilities(root,fetchImpl){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);let reader;
  try{
    const response=await fetchImpl(root+'/health',{method:'GET',redirect:'error',signal:controller.signal});
    if(!response.ok)return null;
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>65536))return null;
    reader=response.body?.getReader();if(!reader)return null;let bytes=0;const chunks=[];
    for(;;){const value=await reader.read();if(value.done)break;bytes+=value.value.byteLength;if(bytes>65536)return null;chunks.push(value.value);}
    const health=JSON.parse(Buffer.concat(chunks).toString('utf8')),capabilities=health.capabilities?.nativeGeometry;
    return health.ok===true&&health.protocolVersion===1&&health.gateway===true&&health.worker===true&&loftHoleLimits(capabilities)?capabilities:null;
  }catch{return null;}finally{clearTimeout(timer);if(reader)await reader.cancel().catch(()=>{});controller.abort();}
}
export function loftCapabilityRequirement(capabilities){
  if(!loftHoleLimits(capabilities))throw new WorkerCapabilityError('WORKER_CAPABILITY_UNAVAILABLE','当前后台未证明实际运行内核支持多孔放样，命令未发送。请使用兼容内核并重新连接工具；不要删除孔参数改成实心体。');
  return {version:1,workerInstance:capabilities.workerInstance,capability:LOFT_HOLES_CAPABILITY};
}
