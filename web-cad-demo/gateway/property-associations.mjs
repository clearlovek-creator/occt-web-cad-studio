import {MAX_PROPERTY_TARGETS,propertyTargets,propertyTargetKey} from '../shared/property-targets.mjs';
import {PropertyAssociationBudget,PROPERTY_ASSOCIATION_LIMIT_REASON} from './property-association-budget.mjs';
const keyOf = target => `${target.bodyId}|${target.topologyId || ""}|${target.bodyIdentity || ""}|${target.topologyIdentity || ""}`;
const sameKind = (kind, value) => new RegExp(`^${kind}-([0-9]+)-([0-9]+)$`).exec(String(value || ""));
const MAX_ASSOCIATION_BRANCHES = 10000;
const stateKey = (target,requiresEvolution) => `${keyOf(target)}@${requiresEvolution}`;
const validRevision=value=>Number.isSafeInteger(value)&&value>0;
function sourceProblem(entry){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.sourceBodyId!=='string'||!entry.sourceBodyId||entry.sourceBodyId.length>256||typeof entry.sourceTopologyId!=='string'||entry.sourceTopologyId.length>96)return 'unindexable';
  const parsed=/^(face|edge)-([0-9]+)-([0-9]+)$/.exec(entry.sourceTopologyId||'');
  if(!parsed||!validRevision(Number(parsed[2]))||!Number.isSafeInteger(Number(parsed[3]))||Number(parsed[3])<1||entry.sourceTopologyId!==`${parsed[1]}-${Number(parsed[2])}-${Number(parsed[3])}`)return 'unindexable';
  if(entry.sourceRevision!==undefined&&entry.sourceRevision!==Number(parsed[2]))return '拓扑血缘来源版本与来源面或边编号不一致，请复核。';
  if(!['sourceBodyIdentity','sourceTopologyIdentity'].every(key=>entry[key]===undefined||entry[key]===''||typeof entry[key]==='string'&&/^[a-f0-9]{32}$/.test(entry[key])))return 'unindexable';
  return '';
}
function revisionProblem(resultRevision,computedRevision,viewRevision){
  return !validRevision(resultRevision)||!validRevision(computedRevision)||resultRevision>computedRevision
    ||viewRevision!==undefined&&(!validRevision(viewRevision)||computedRevision>viewRevision||resultRevision>viewRevision)
    ?'拓扑血缘缺少有效版本，或版本超出当前工程/特征，未将其视为已验证映射。':'';
}
function validLineageDestination(target, kind) {
  if (!target || typeof target !== 'object' || Array.isArray(target)
      || typeof target.bodyId !== 'string' || !target.bodyId || target.bodyId.length>256
      || typeof target.topologyId!=='string'||target.topologyId.length>96
      || (target.kind !== undefined && target.kind !== kind)) return false;
  const parsed = sameKind(kind, target.topologyId);
  if (!parsed) return false;
  const revision = Number(parsed[1]), index = Number(parsed[2]);
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(index) || index < 1
      || target.topologyId !== `${kind}-${revision}-${index}`
      || (target.topologyRevision !== undefined && target.topologyRevision !== revision)) return false;
  return ['bodyIdentity', 'topologyIdentity'].every(key => target[key] === undefined
    || (typeof target[key] === 'string' && /^[a-f0-9]{32}$/.test(target[key])));
}
/** Kahn's algorithm distinguishes a real reachable cycle from ordinary
 * convergent lineage, without recursion proportional to the history depth. */
function hasLineageCycle(edges,budget) {
  const incoming = new Map();
  for (const [source, targets] of edges) {
    if(!budget.work())return null;
    if (!incoming.has(source)){if(!budget.take('stateBytes',96))return null;incoming.set(source, 0);}
    for (const target of targets){if(!budget.work())return null;if(!incoming.has(target)&&!budget.take('stateBytes',96))return null;incoming.set(target, (incoming.get(target) || 0) + 1);}
  }
  const ready=[];for(const [key,count]of incoming){if(!budget.work())return null;if(count===0){if(!budget.take('stateBytes',8))return null;ready.push(key);}}
  let removed = 0;
  for (let cursor = 0; cursor < ready.length; cursor++) {
    if(!budget.work())return null;
    const source = ready[cursor];
    removed++;
    for (const target of edges.get(source) || []) {
      if(!budget.work())return null;
      const count = incoming.get(target) - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  return removed < incoming.size;
}

export function checkPropertyTarget(target, view, bodyIndex = null, {requireIdentity=false} = {}) {
  if (!target) return {ok:true,target:null};
  if(view?.ok === false)return {ok:false,reason:"几何内核暂不可用，无法验证属性关联。"};
  if (!["body","face","edge"].includes(target.kind)) return {ok:false,reason:"属性关联类型必须是 Body、Face 或 Edge。"};
  if(typeof target.bodyId!=='string'||!target.bodyId||target.bodyId.length>256||target.kind!=='body'&&(typeof target.topologyId!=='string'||target.topologyId.length>96)||['bodyIdentity','topologyIdentity'].some(key=>target[key]!==undefined&&target[key]!==''&&(typeof target[key]!=='string'||!/^[a-f0-9]{32}$/.test(target[key]))))return {ok:false,invalid:true,reason:'属性关联身份格式无效或超出长度限制。'};
  const body = bodyIndex ? bodyIndex.get(target.bodyId) : (view.bodies || view.bodyMetadata || []).find(body => (body.id || body.bodyId) === target.bodyId);
  const identity=view.entityIdentities?.[target.bodyId] || body;
  if(body && target.bodyIdentity && !identity?.bodyIdentity)return {ok:false,reason:"当前内核未提供此对象的持久身份，无法验证原关联。"};
  if(identity?.bodyIdentity && target.bodyIdentity && identity.bodyIdentity!==target.bodyIdentity)return {ok:false,missing:true,reason:"编号已属于另一个几何对象，原属性不会自动转移到新对象。"};
  if(requireIdentity && identity?.bodyIdentity && !target.bodyIdentity)return {ok:false,reason:"旧关联缺少持久对象身份，属性值已保留，请确认并重新关联。"};
  if (!body) return {ok:false,reason:`关联 Body ${target.bodyId} 已不存在。`,missing:true};
  const bodyIdentity=identity?.bodyIdentity ? {bodyIdentity:identity.bodyIdentity} : {};
  if (target.kind === "body") return {ok:true,target:{kind:"body",bodyId:target.bodyId,...bodyIdentity}};
  if(requireIdentity && body.topologyIdentity && !target.topologyIdentity)return {ok:false,reason:"旧关联缺少持久拓扑身份，不能仅按面或边编号恢复，请复核。"};
  if(target.topologyIdentity && body.topologyIdentity!==target.topologyIdentity)return {ok:false,reason:"拓扑身份已变化，需要依据真实操作血缘重新解析。"};
  const parsed = sameKind(target.kind,target.topologyId);
  if (!parsed) return {ok:false,reason:"属性关联的拓扑 ID 格式无效。",missing:true};
  const revision=Number(parsed[1]), index=Number(parsed[2]);
  if(target.topologyId !== `${target.kind}-${revision}-${index}`)return {ok:false,reason:"属性关联必须使用规范拓扑 ID，不能包含前导零或额外字符。",missing:true};
  if (revision !== body.topologyRevision || (target.topologyRevision !== undefined && target.topologyRevision !== revision)) return {ok:false,reason:"关联拓扑版本已变化，需要依据真实操作血缘重新解析。"};
  const count=body[target.kind === "face" ? "faceCount" : "edgeCount"];
  if (!Number.isSafeInteger(count)) return {ok:false,reason:"当前内核未提供拓扑数量，无法验证此关联；请升级内核。"};
  if (!Number.isSafeInteger(index) || index < 1 || index > count) return {ok:false,reason:"关联的面或边不存在。",missing:true};
  return {ok:true,target:{kind:target.kind,bodyId:target.bodyId,topologyId:target.topologyId,topologyRevision:revision,...bodyIdentity,...(body.topologyIdentity?{topologyIdentity:body.topologyIdentity}:{})}};
}

/** Resolve stored anchors against authoritative operation evidence; never mutate
 * anchors while reading. Undo, redo and project reopening can therefore resolve
 * the same instance against their own exact CAD state. */
export function resolvePropertySchema(schema, view,{limits={}}={}) {
  const budget=new PropertyAssociationBudget(limits);
  if(!Array.isArray(schema.instances)||schema.instances.length>10000||!Array.isArray(schema.types)||schema.types.length>1000)throw Error('Invalid property association schema size.');
  const bodyIndex=new Map(),index=new Map(),cache=new Map();let bodiesBuilt=false,bodyLookupLimited=false,indexBuilt=false,indexLimited=false,incompleteEvidence=false;
  const limited=anchor=>({state:'needs-review',target:anchor,stateReason:PROPERTY_ASSOCIATION_LIMIT_REASON,association:{status:'unresolved',anchor,candidates:[],budgetLimited:true,candidatesTruncated:true}});
  function ensureBodies(){
    if(bodiesBuilt)return;bodiesBuilt=true;const bodies=view.bodies||view.bodyMetadata||[];
    for(let i=0;i<bodies.length;i++){
      if(!budget.take('bodyRecords')||!budget.work()){bodyLookupLimited=true;break;}
      const body=bodies[i],id=body?.id||body?.bodyId;if(typeof id!=='string'||id.length>256){bodyLookupLimited=true;continue;}
      if(!budget.take('stateBytes',128+id.length*2)){bodyLookupLimited=true;break;}bodyIndex.set(id,body);
    }
  }
  function checkCurrent(target){
    if(!target)return {ok:true,target:null};ensureBodies();
    if(bodyLookupLimited&&!bodyIndex.has(target.bodyId))return {ok:false,budgetLimited:true,reason:PROPERTY_ASSOCIATION_LIMIT_REASON};
    return checkPropertyTarget(target,view,bodyIndex,{requireIdentity:true});
  }
  function add(entry,record){
    const problem=sourceProblem(entry);if(problem==='unindexable'){incompleteEvidence=true;return true;}
    const key=keyOf({bodyId:entry.sourceBodyId,topologyId:entry.sourceTopologyId,bodyIdentity:entry.sourceBodyIdentity,topologyIdentity:entry.sourceTopologyIdentity});
    if(!budget.take('stateBytes',96+(index.has(key)?0:64+key.length*2))){indexLimited=true;return false;}
    if(!index.has(key))index.set(key,[]);index.get(key).push({...record,entry,invalidReason:record.invalidReason||problem});return true;
  }
  function ensureIndex(){
    if(indexBuilt)return;indexBuilt=true;budget.indexBuilt=true;const features=view.features;incompleteEvidence=features!==undefined&&!Array.isArray(features);
    const all=Array.isArray(features)?features:[];
    indexing:for(let order=0;order<all.length;order++){
    if(!budget.take('featureRecords')||!budget.work()){indexLimited=true;break;}
    const feature=all[order];
    if(!feature||typeof feature!=='object'||Array.isArray(feature)){incompleteEvidence=true;continue;}
    const lineage=feature.topologyLineage;
    if (lineage?.version === 1 && lineage.basis === "occt-history") {
      const invalidReason=revisionProblem(lineage.resultRevision,feature.computedRevision,view.revision)||(!['current','stale'].includes(lineage.state)?'拓扑血缘记录状态无效，请复核。':'');
      const current=!invalidReason&&lineage.state === "current" && lineage.resultRevision === feature.computedRevision;
      if(!Array.isArray(lineage.entries))incompleteEvidence=true;
      else for(let i=0;i<lineage.entries.length;i++){
        if(!budget.take('lineageRecords')||!budget.work()){indexLimited=true;break indexing;}
        if(!add(lineage.entries[i],{order,current,semantic:false,resultRevision:lineage.resultRevision,invalidReason}))break indexing;
      }
    }else if(lineage!==undefined&&lineage!==null)incompleteEvidence=true;
    const evolutions=feature.topologyEvolutions;
    if(evolutions?.version===1 && evolutions.basis==="semantic-topology-v1"){
      if(!Array.isArray(evolutions.entries))incompleteEvidence=true;
      else for(let i=0;i<evolutions.entries.length;i++){
        if(!budget.take('lineageRecords')||!budget.work()){indexLimited=true;break indexing;}
        const entry=evolutions.entries[i];if(!add(entry,{order,current:true,semantic:true,resultRevision:entry?.resultRevision,invalidReason:revisionProblem(entry?.resultRevision,feature.computedRevision,view.revision)}))break indexing;
      }
    }else if(evolutions!==undefined&&evolutions!==null)incompleteEvidence=true;
  }
  }
  function emit(result,anchor){const count=result.association.candidates.length;if(!budget.take('candidateSlots',count)||!budget.take('stateBytes',32+count*16))return limited(anchor);return result;}
  function remember(identity,result){if(identity!==null&&budget.take('stateBytes',96+identity.length*2,{optional:true})){if(cache.size>=budget.limits.cacheEntries)cache.delete(cache.keys().next().value);cache.set(identity,result);budget.cachePeak=Math.max(budget.cachePeak,cache.size);}return result;}
  function resolve(anchor,allowMany=false,emitCandidates=true) {
    if(!budget.work())return limited(anchor);
    const fields=[anchor.kind,anchor.bodyId,anchor.topologyId,anchor.topologyRevision,anchor.bodyIdentity,anchor.topologyIdentity,allowMany],identity=fields.some(v=>v!==null&&v!==undefined&&!['string','number','boolean'].includes(typeof v)||typeof v==='string'&&v.length>256)?null:JSON.stringify(fields.map(value=>[typeof value,value]));
    if(identity!==null&&cache.has(identity)){budget.cacheHits++;const result=cache.get(identity);return emitCandidates?emit(result,anchor):result;}
    const direct=checkCurrent(anchor);
    if(direct.ok){const result=remember(identity,{state:'active',target:direct.target,...(allowMany?{targets:[direct.target]}:{}),association:{status:'verified',anchor,candidates:[direct.target]}});return emitCandidates?emit(result,anchor):result;}
    if(direct.invalid)return {state:'needs-review',target:anchor,stateReason:direct.reason,association:{status:'unresolved',anchor,candidates:[]}};
    if(direct.budgetLimited)return limited(anchor);
    ensureIndex();
    if(!budget.take('stateBytes',256+stateKey(anchor,false).length*2))return limited(anchor);
    const queue=[{target:anchor,requiresEvolution:false}],found=new Map(),visited=new Set(),scheduled=new Set([stateKey(anchor,false)]),edges=new Map();
    let uncertain=indexLimited, deleted=false, reason=indexLimited?PROPERTY_ASSOCIATION_LIMIT_REASON:'', expanded=0, inspected=0,truncated=false;
    traversal: for(let cursor=0;cursor<queue.length;cursor++) {
      if(!budget.work()){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;break;}
      if(found.size>MAX_PROPERTY_TARGETS){uncertain=true;truncated=true;reason="关联候选过多，本次只保留部分已验证候选，需要人工复核。";break;}
      const {target,requiresEvolution}=queue[cursor], key=keyOf(target), visit=stateKey(target,requiresEvolution);
      if(visited.has(visit))continue;visited.add(visit);
      const checked=cursor===0?direct:checkCurrent(target);
      if(checked.budgetLimited){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;continue;}
      if(checked.ok){if(requiresEvolution){uncertain=true;reason="旧操作血缘尚无有效的重算身份桥接。";}else if(!found.has(key)){if(!budget.take('stateBytes',128+key.length*2)){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;break;}found.set(key,checked.target);}continue;}
      if(indexLimited){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;}else if(incompleteEvidence){uncertain=true;reason="工程中存在无法完整读取的拓扑血缘记录，旧关联不能被认定为已删除或完整继承，请复核。";}
      const successors=index.get(key) || [];
      let applicable=false;
      for(const next of successors) {
        // Empty/deletion/retained-input records consume work too. Filtering
        // first would allocate and inspect the entire unbounded source list.
        if(++inspected>MAX_ASSOCIATION_BRANCHES){uncertain=true;reason="关联血缘记录过多，需要人工复核。";break traversal;}
        if(!budget.work()){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;break traversal;}
        if(next.invalidReason){uncertain=true;reason=next.invalidReason;applicable=true;continue;}
        const preserved=next.entry.inputPreserved;
        if(preserved!==undefined&&typeof preserved!=='boolean'){uncertain=true;reason="拓扑血缘保留输入标志无效，请复核。";applicable=true;continue;}
        if(preserved)continue;
        applicable=true;
        if(next.semantic && next.entry.state!=="mapped"){uncertain=true;reason="重算后的生成身份不完整或不唯一，请复核关联。";continue;}
        if(!Array.isArray(next.entry.destinations)){uncertain=true;reason="拓扑血缘分支记录不完整，无法验证关联。";continue;}
        if(!next.entry.destinations.length){if(next.semantic){uncertain=true;reason="重算映射标为已对应但缺少后代记录，无法证明删除或继承，请复核。";}else if(next.current)deleted=true;else{uncertain=true;reason="旧拓扑已删除，重算后未能证明其身份。";}continue;}
        for(let i=0;i<next.entry.destinations.length;i++){
          // Enforce the existing branch budget before retaining another node;
          // one enormous entry must not first allocate an unbounded queue.
          if(++expanded>MAX_ASSOCIATION_BRANCHES){uncertain=true;reason="关联分支过多，需要人工复核。";break traversal;}
          if(!budget.work()){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;break traversal;}
          const destination=next.entry.destinations[i];
          if(!validLineageDestination(destination,anchor.kind)){uncertain=true;reason="拓扑血缘分支目标无效，未将其视为已删除或已验证。";continue;}
          if(Number(sameKind(anchor.kind,destination.topologyId)[1])>next.resultRevision){uncertain=true;reason="拓扑血缘目标版本晚于其声明的结果版本，未将其视为已验证映射。";continue;}
          const successor={target:{...destination,kind:anchor.kind},requiresEvolution:next.semantic?false:requiresEvolution || !next.current},successorKey=stateKey(successor.target,successor.requiresEvolution);
          if(!edges.get(visit)?.has(successorKey)){if(!budget.take('stateBytes',128+successorKey.length*2)){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;break traversal;}if(!edges.has(visit))edges.set(visit,new Set());edges.get(visit).add(successorKey);}
          if(!scheduled.has(successorKey)){if(!budget.take('stateBytes',256+successorKey.length*2)){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;break traversal;}scheduled.add(successorKey);queue.push(successor);}
        }
      }
      if(!applicable){if(indexLimited){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;}else if(requiresEvolution){uncertain=true;reason="旧操作血缘尚无有效的重算身份桥接。";}else if(checked.missing)deleted=true;else{uncertain=true;reason=checked.reason;}}
    }
    if(!uncertain){const cycle=hasLineageCycle(edges,budget);if(cycle===null){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;}else if(cycle){uncertain=true;reason="拓扑血缘存在循环，无法证明所有关联分支，请复核或修复工程。";}}
    const candidateCount=found.size,candidates=[...found.values()].slice(0,MAX_PROPERTY_TARGETS);truncated ||= candidateCount>MAX_PROPERTY_TARGETS;
    if(truncated){uncertain=true;reason="关联候选过多，本次只保留部分已验证候选，需要人工复核。";}
    if(indexLimited){uncertain=true;reason=PROPERTY_ASSOCIATION_LIMIT_REASON;}
    if(!candidates.length && !deleted && !uncertain){uncertain=true;reason="没有可验证的当前拓扑关联路径。";}
    const result = !uncertain && candidates.length>0 && (candidates.length===1 || allowMany) ? {state:"active",target:candidates.length===1?candidates[0]:null,...(allowMany?{targets:candidates}:{}),association:{status:candidates.length===1&&keyOf(candidates[0])===keyOf(anchor)?"verified":"remapped",anchor,candidates}}
      : {state:!uncertain && !candidates.length && deleted ? "orphaned":"needs-review",target:anchor,stateReason:reason || (candidates.length>1?`关联已分裂为 ${candidates.length} 个面或边，需选择确认，未自动取第一个。`:"原关联拓扑已删除，属性值保留，请重新指定。"),association:{status:uncertain?"unresolved":candidates.length>1?"ambiguous":"deleted",anchor,candidates,...(truncated?{candidateCount,candidatesTruncated:true}:{})}};
    remember(identity,result);return emitCandidates?emit(result,anchor):result;
  }
  const types=new Map((schema.types||[]).map(type=>[type.typeId,type]));
  const instances=schema.instances.map(instance=>{
    if(instance.state && instance.state !== "active")return instance;
    if(!instance.target&&!Array.isArray(instance.targets))return instance;
    if(!budget.work())return {...instance,...limited(instance.target),...(Array.isArray(instance.targets)?{target:null,targets:instance.targets,association:{status:'unresolved',anchors:instance.targets,candidates:[],members:[],membersTruncated:true,budgetLimited:true}}:{})};
    if(Array.isArray(instance.targets)){
      const anchors=propertyTargets(instance),type=types.get(instance.typeId);
      if(type?.targetMode!=='multiple' || (view?.ok===false&&anchors.length))return {...instance,state:'needs-review',stateReason:'关联集合尚未得到有效类型或当前几何验证。',association:{status:'unresolved',anchors,candidates:[],members:[]}};
      const members=[];for(const anchor of anchors){
        if(!budget.work())return {...instance,state:'needs-review',stateReason:PROPERTY_ASSOCIATION_LIMIT_REASON,association:{status:'unresolved',anchors,candidates:[],members:[],membersTruncated:true,budgetLimited:true}};
        if(!anchor.bodyIdentity || (anchor.kind!=='body'&&!anchor.topologyIdentity)){members.push({state:'needs-review',stateReason:'集合成员缺少持久身份，需显式重新关联。',association:{status:'unresolved',candidates:[]}});continue;}
        if(anchor.kind!=='body'){members.push(resolve(anchor,type.splitPolicy==='all-descendants',false));continue;}
        const checked=checkCurrent(anchor);members.push(checked.ok?{state:'active',target:checked.target,association:{status:'verified',candidates:[checked.target]}}:{state:checked.budgetLimited?'needs-review':checked.missing?'orphaned':'needs-review',stateReason:checked.reason,association:{status:checked.missing&&!checked.budgetLimited?'deleted':'unresolved',candidates:[]}});
      }
      const diagnosticCount=members.reduce((sum,m)=>sum+m.association.candidates.length,0);
      if(!budget.take('workUnits',diagnosticCount*2+members.length)||!budget.take('candidateSlots',diagnosticCount+Math.min(diagnosticCount,MAX_PROPERTY_TARGETS))||!budget.take('stateBytes',128*members.length+32*diagnosticCount))return {...instance,state:'needs-review',stateReason:PROPERTY_ASSOCIATION_LIMIT_REASON,association:{status:'unresolved',anchors,candidates:[],members:[],membersTruncated:true,budgetLimited:true}};
      const candidatesMap=new Map();
      gathering:for(const member of members)for(const target of member.association.candidates){const key=propertyTargetKey(target);if(candidatesMap.has(key))continue;if(!budget.take('stateBytes',128+key.length*2))return {...instance,state:'needs-review',stateReason:PROPERTY_ASSOCIATION_LIMIT_REASON,association:{status:'unresolved',anchors,candidates:[],members:[],membersTruncated:true,budgetLimited:true}};candidatesMap.set(key,target);if(candidatesMap.size>MAX_PROPERTY_TARGETS)break gathering;}
      const allCandidates=[...candidatesMap.values()],candidates=allCandidates.slice(0,MAX_PROPERTY_TARGETS),candidateIndex=new Map(candidates.map((target,index)=>[propertyTargetKey(target),index])),truncated=allCandidates.length>MAX_PROPERTY_TARGETS||members.some(m=>m.association.candidatesTruncated),candidateCount=Math.max(allCandidates.length,...members.map(m=>m.association.candidateCount||0));
      const complete=members.every(member=>member.state==='active')&&allCandidates.length<=MAX_PROPERTY_TARGETS;
      const state=complete?'active':members.length&&members.every(member=>member.state==='orphaned')?'orphaned':'needs-review';
      return {...instance,target:null,targets:complete?candidates:anchors,state,...(complete?{}:{stateReason:members.some(m=>m.stateReason===PROPERTY_ASSOCIATION_LIMIT_REASON)?PROPERTY_ASSOCIATION_LIMIT_REASON:truncated?`关联后代超过 ${MAX_PROPERTY_TARGETS} 项，需要拆分关联集合。`:'关联集合存在分裂、删除或无法验证的成员，属性值已保留，请逐项复核。'}),association:{status:complete?(members.every(member=>member.association.status==='verified')?'verified':'remapped'):members.some(member=>member.association.status==='ambiguous')?'ambiguous':'partial',anchors,candidates,candidateCount,candidatesTruncated:truncated,members:members.map((member,index)=>({index,anchor:anchors[index],state:member.state,status:member.association.status,...(member.stateReason?{reason:member.stateReason}:{}),candidateCount:member.association.candidateCount||member.association.candidates.length,candidateIndexes:member.association.candidates.map(target=>candidateIndex.get(propertyTargetKey(target))).filter(index=>index!==undefined)}))}};
    }
    if(view?.ok === false && instance.target)return {...instance,state:"needs-review",stateReason:"几何内核暂不可用，关联尚未验证。"};
    if(!instance.target || instance.target.kind === "body") {
      const checked=checkCurrent(instance.target);
      return checked.ok?{...instance,target:checked.target}:{...instance,state:checked.budgetLimited?'needs-review':checked.missing?"orphaned":"needs-review",stateReason:checked.reason,association:{status:checked.missing&&!checked.budgetLimited?"deleted":"unresolved",anchor:instance.target,candidates:[]}};
    }
    return {...instance,...resolve(instance.target)};
  });
  return {...schema,instances,associationResolution:budget.report()};
}
