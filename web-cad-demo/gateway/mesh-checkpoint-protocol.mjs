import {DiscreteTetraError,normalizeDiscreteTetraInput,assertDiscreteTetraInput,assertDiscreteTetraResult,discreteTetraFailure} from './discrete-tetra-protocol.mjs';
import {assertNativeMemoryGuard,meshMemoryPolicy} from './native-resource-policy.mjs';

export const MESH_CHECKPOINT_PROTOCOL=Object.freeze({version:1,basis:'gmsh-linear-mesh-checkpoint-v1',optimizationBasis:'gmsh-checkpoint-optimization-v1',snapshotBasis:'bounded-gmsh-entity-mesh-v1',processMode:'checkpoint-only-v1',gmshVersion:'4.15.2',apiVersion:'4.15.2',license:'GPL-3.0-or-later',maxRequestBytes:128*1024**2,maxResponseBytes:128*1024**2,maxEntities:200000,maxNodes:100000,maxElements:1000000,maxTag:1000000,maxEntityTag:200000,oneJobPerProcess:true,automaticReplay:false,normalMeshAdmitted:false,userConfigLoaded:false});
const P=MESH_CHECKPOINT_PROTOCOL,plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),finite=value=>typeof value==='number'&&Number.isFinite(value),integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const fault=()=>new DiscreteTetraError('MESH_CHECKPOINT_INVALID','网格检查点的实体、节点、单元、边界或来源不一致；未开始优化或接纳结果。');
const check=value=>{if(!value)throw fault();};
const fields=(value,names)=>check(plain(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name)));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function equivalent(a,b){if(a===b)return true;if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,i)=>equivalent(value,b[i]));if(!plain(a)||!plain(b))return false;const keys=Object.keys(a).sort(),other=Object.keys(b).sort();return keys.length===other.length&&keys.every((key,i)=>key===other[i]&&equivalent(a[key],b[key]));}
const sortedTags=(value,limit=P.maxTag)=>Array.isArray(value)&&value.every((n,i)=>integer(n,1,limit)&&(i===0||n>value[i-1]));
const triangleKey=nodes=>{const first=nodes.indexOf(Math.min(...nodes));return [0,1,2].map(i=>nodes[(first+i)%3]).join(',');};
const edgeKey=nodes=>[...nodes].sort((a,b)=>a-b).join(',');
const legacy=(mesh,id)=>({...mesh,protocolVersion:1,requestId:id,service:'gmsh-mesh-worker',operation:'mesh.discrete-tetra'});
const rawFields=['ok','basis','gmshVersion','points','cells','boundaries','sourceSolids','sources','report','quality','optimization'];
export function checkpointBaselineInput(input){const {domain,meshSize,quality}=input;return {domain,meshSize,quality:{...quality,mode:'diagnostic'}};}
export function normalizeCheckpointInput(input){return normalizeDiscreteTetraInput(input);}
export function assertCheckpointInput(input,context){
  assertDiscreteTetraInput(input,context);check(input.optimization!==undefined);return input;
}
export function assertCheckpointHandshake(health,{optimization=false}={}){
  const actual=health?.capabilities?.meshCheckpoint;
  check(health?.ok===true&&health.protocolVersion===1&&health.service==='gmsh-mesh-worker'&&health.capabilities?.version===1&&plain(actual)&&Object.entries(P).every(([key,value])=>actual[key]===value));
  return {version:1,basis:optimization?P.optimizationBasis:P.basis,gmshVersion:P.gmshVersion,apiVersion:P.apiVersion,license:P.license};
}
function envelope(result,id,operation,basis){check(result?.ok===true&&result.protocolVersion===1&&result.requestId===id&&result.service==='gmsh-mesh-worker'&&result.operation===operation&&result.basis===basis&&result.gmshVersion===P.gmshVersion&&result.normalMeshAdmitted===false);}
function setEqual(a,b){check(a.size===b.size&&[...a].every(value=>b.has(value)));}
function recordElementEdges(rows){
  const edges=new Map();for(const triangle of rows)for(let i=0;i<3;i++){const pair=[triangle[i],triangle[(i+1)%3]],key=edgeKey(pair),row=edges.get(key)||{count:0,orientation:0};row.count++;row.orientation+=pair[0]<pair[1]?1:-1;edges.set(key,row);}return edges;
}
/** The explicit node tag/index map is authoritative, never coordinate matching.
 * All lower-dimensional topology is checked against the already independently
 * validated boundary triangles before it can reach the native importer. */
export function validateMeshCheckpoint(checkpoint,baseline,input,{patched=false}={}){
  fields(checkpoint,['version','basis','worldOrigin','pointNodeTags','entities']);
  check(checkpoint.version===(patched?2:1)&&checkpoint.basis===(patched?'bounded-gmsh-embedded-entity-mesh-v2':P.snapshotBasis)&&same(checkpoint.worldOrigin,input.domain.points[0])&&sortedTags(checkpoint.pointNodeTags)&&checkpoint.pointNodeTags.length===baseline.points.length&&checkpoint.pointNodeTags.length<=P.maxNodes&&Array.isArray(checkpoint.entities)&&checkpoint.entities.length>0&&checkpoint.entities.length<=P.maxEntities);
  const tagToIndex=new Map(checkpoint.pointNodeTags.map((tag,i)=>[tag,i])),nodes=new Map(),entities=new Map(),elementTags=new Set(),surfaces=new Map(),volumes=new Map(),curves=new Map(),points=new Map();let nodeCount=0,elementCount=0,boundaryCount=0,previous=[-1,0];
  for(const entity of checkpoint.entities){
    fields(entity,['dimension','tag','boundary','nodes','coordinates','parameters','types','elements','vertices',...(patched?['embedded']:[])]);const dim=entity.dimension,tag=entity.tag,id=dim+':'+tag;
    check(integer(dim,0,3)&&integer(tag,1,P.maxEntityTag)&&(dim>previous[0]||dim===previous[0]&&tag>previous[1])&&!entities.has(id));previous=[dim,tag];entities.set(id,entity);
    check(Array.isArray(entity.boundary)&&entity.boundary.every((n,i)=>integer(n,-P.maxEntityTag,P.maxEntityTag)&&n!==0&&(i===0||n>entity.boundary[i-1])&&dim>0&&entities.has((dim-1)+':'+Math.abs(n)))&&new Set(entity.boundary.map(Math.abs)).size===entity.boundary.length);boundaryCount+=entity.boundary.length;check(boundaryCount<=1000000);
    if(patched){check(Array.isArray(entity.embedded));let previous=[-1,0];for(const ref of entity.embedded){check(Array.isArray(ref)&&ref.length===2&&dim>=2&&integer(ref[0],0,dim-1)&&integer(ref[1],1,P.maxEntityTag)&&entities.has(ref.join(':'))&&(ref[0]>previous[0]||ref[0]===previous[0]&&ref[1]>previous[1])&&!(ref[0]===dim-1&&entity.boundary.some(n=>Math.abs(n)===ref[1])));previous=ref;check(++boundaryCount<=1000000);}}
    check(sortedTags(entity.nodes)&&Array.isArray(entity.coordinates)&&entity.coordinates.length===entity.nodes.length*3&&entity.coordinates.every(n=>finite(n)&&Math.abs(n)<=2e12)&&Array.isArray(entity.parameters)&&entity.parameters.every(n=>finite(n)&&Math.abs(n)<=1e100)&&(entity.parameters.length===0||entity.parameters.length===dim*entity.nodes.length));
    nodeCount+=entity.nodes.length;check(nodeCount<=P.maxNodes);
    for(let i=0;i<entity.nodes.length;i++){
      const n=entity.nodes[i],index=tagToIndex.get(n);check(index!==undefined&&!nodes.has(n));const local=entity.coordinates.slice(i*3,i*3+3),world=local.map((v,k)=>v+checkpoint.worldOrigin[k]);
      check(world.every((v,k)=>finite(v)&&Math.abs(v)<=1e12&&v===baseline.points[index][k]&&v-checkpoint.worldOrigin[k]===local[k]));nodes.set(n,{index,world,dimension:dim,entityTag:tag});
    }
    const expectedType=[15,1,2,4][dim],width=dim+1;
    check(Array.isArray(entity.types)&&entity.types.length===1&&entity.types[0]===expectedType&&Array.isArray(entity.elements)&&entity.elements.length===1&&sortedTags(entity.elements[0])&&entity.elements[0].length>0&&Array.isArray(entity.vertices)&&entity.vertices.length===1&&entity.vertices[0].length===width*entity.elements[0].length);
    elementCount+=entity.elements[0].length;check(elementCount<=P.maxElements);
    for(const n of entity.elements[0]){check(!elementTags.has(n));elementTags.add(n);}
    const rows=[];for(let i=0;i<entity.vertices[0].length;i+=width){const row=entity.vertices[0].slice(i,i+width);check(new Set(row).size===width&&row.every(n=>integer(n,1,P.maxTag)));rows.push(row);}
    if(dim===0){check(entity.nodes.length===1&&rows.length===1&&rows[0][0]===entity.nodes[0]&&entity.boundary.length===0);points.set(tag,rows[0][0]);}
    if(dim===1)curves.set(tag,{entity,rows});
    if(dim===2)surfaces.set(tag,{entity,rows});
    if(dim===3)volumes.set(tag,{entity,rows});
  }
  check(nodeCount===checkpoint.pointNodeTags.length&&nodes.size===tagToIndex.size);
  for(const entity of checkpoint.entities)check(entity.vertices[0].every(n=>nodes.has(n)));
  check(surfaces.size===(patched?baseline.patches:baseline.boundaries).length&&volumes.size===baseline.cells.length);
  if(patched)return validatePatchedCheckpointTopology({checkpoint,baseline,input,tagToIndex,nodes,entities,surfaces,volumes,curves,points});
  const usedCurves=new Set(),usedPoints=new Set();
  for(const [tag,{entity,rows}]of curves){
    const degree=new Map();for(const [a,b]of rows){degree.set(a,(degree.get(a)||0)-1);degree.set(b,(degree.get(b)||0)+1);}const endpoints=new Map();
    // Gmsh exposes point boundaries without orientation. The directed line
    // elements, not a sign on a zero-dimensional entity, define curve direction.
    for(const use of entity.boundary){check(use>0);const node=points.get(use);check(node!==undefined&&!endpoints.has(node));usedPoints.add(use);endpoints.set(node,true);}
    for(const [node,count]of degree)check(Math.abs(count)===(endpoints.has(node)?1:0));for(const node of endpoints.keys())check(Math.abs(degree.get(node)||0)===1);
    check(tag>0);
  }
  for(let i=0;i<baseline.boundaries.length;i++){
    const actual=surfaces.get(i+1);check(actual!==undefined);const expected=baseline.boundaries[i].triangles.map(row=>row.map(n=>checkpoint.pointNodeTags[n]));setEqual(new Set(actual.rows.map(triangleKey)),new Set(expected.map(triangleKey)));check(actual.rows.length===expected.length);
    const edgeUses=recordElementEdges(actual.rows),outer=new Map([...edgeUses].filter(([,row])=>row.count===1)),lineUses=new Map();for(const row of edgeUses.values())check(row.count===1||row.count===2&&row.orientation===0);
    // Discrete GFace boundary uses are adjacency-only in the pinned SDK.
    // Surface/tet element connectivity remains oriented and independently
    // checked; inventing signs on these unsigned curve uses would reject valid
    // checkpoints. Require exact edge coverage without guessing those signs.
    for(const use of actual.entity.boundary){check(use>0);const curve=curves.get(use);check(curve!==undefined);usedCurves.add(use);for(const pair of curve.rows){const key=edgeKey(pair);check(!lineUses.has(key));lineUses.set(key,true);}}
    check(lineUses.size===outer.size);for(const key of outer.keys())check(lineUses.has(key));
  }
  check(usedCurves.size===curves.size&&usedPoints.size===points.size);
  for(let i=0;i<baseline.cells.length;i++){
    const actual=volumes.get(i+1);check(actual!==undefined);const expected=baseline.cells[i].tetrahedra.map(row=>row.map(n=>checkpoint.pointNodeTags[n]).join(','));check(actual.rows.length===expected.length);setEqual(new Set(actual.rows.map(row=>row.join(','))),new Set(expected));
    const boundary=input.domain.cells[i].shells.flatMap(shell=>shell.triangleIndexes.map(index=>{const use=input.domain.triangleCellUses[index].find(row=>row.cellIndex===i);check(use!==undefined);return (index+1)*use.orientation;})).sort((a,b)=>a-b);check(same(actual.entity.boundary,boundary));
  }
  return {nodes,surfaces,volumes};
}
function validatePatchedCheckpointTopology({checkpoint,baseline,input,tagToIndex,nodes,entities,surfaces,volumes,curves,points}){
  const plan=input.patchPlan,expectedPoints=new Set(plan.edges.flatMap(e=>e.vertices.map(i=>i+1)));
  check(points.size===expectedPoints.size&&[...points.keys()].every(i=>expectedPoints.has(i))&&curves.size===plan.edges.length&&surfaces.size===plan.patches.length);
  for(const [tag,node]of points)check(same(baseline.points[tagToIndex.get(node)],input.domain.points[tag-1]));
  for(let e=0;e<plan.edges.length;e++){
    const actual=curves.get(e+1);check(actual!==undefined&&actual.entity.embedded.length===0);
    const wanted=plan.edges[e].vertices.map(i=>i+1).sort((a,b)=>a-b);check(same(actual.entity.boundary,wanted));
    const start=points.get(wanted[0]),end=points.get(wanted[1]),next=new Map(),incoming=new Set();
    for(const [a,b]of actual.rows){check(!next.has(a)&&!incoming.has(b));next.set(a,b);incoming.add(b);}
    const visited=new Set();let node=start;while(node!==end){check(!visited.has(node)&&next.has(node));visited.add(node);node=next.get(node);}check(visited.size===actual.rows.length&&!next.has(end));
  }
  for(let p=0;p<plan.patches.length;p++){
    const actual=surfaces.get(p+1),patch=plan.patches[p];check(actual!==undefined);
    const expected=baseline.patches[p].triangles.map(row=>row.map(n=>checkpoint.pointNodeTags[n]));check(actual.rows.length===expected.length);setEqual(new Set(actual.rows.map(triangleKey)),new Set(expected.map(triangleKey)));
    const edgeUses=recordElementEdges(actual.rows);for(const use of edgeUses.values())check(use.count===1||use.count===2&&use.orientation===0);
    const loops=patch.loops.flatMap(loop=>loop.edgeUses),boundary=loops.map(n=>Math.abs(n)).sort((a,b)=>a-b);
    check(same(actual.entity.boundary.map(Math.abs).sort((a,b)=>a-b),boundary));
    check(same(actual.entity.embedded,patch.embeddedEdgeIndexes.map(i=>[1,i+1]).sort((a,b)=>a[1]-b[1])));
    const covered=new Set();
    for(const use of loops){const curve=curves.get(Math.abs(use));check(curve!==undefined);for(const [a,b]of curve.rows){const id=edgeKey([a,b]),row=edgeUses.get(id);check(row?.count===1&&!covered.has(id)&&row.orientation===Math.sign(use)*(a<b?1:-1));covered.add(id);}}
    check(covered.size===[...edgeUses.values()].filter(row=>row.count===1).length);
    for(const e of patch.embeddedEdgeIndexes){const curve=curves.get(e+1);for(const pair of curve.rows)check(edgeUses.get(edgeKey(pair))?.count===2);}
  }
  for(let c=0;c<baseline.cells.length;c++){
    const actual=volumes.get(c+1);check(actual!==undefined);const expected=baseline.cells[c].tetrahedra.map(row=>row.map(i=>checkpoint.pointNodeTags[i]).join(','));check(actual.rows.length===expected.length);setEqual(new Set(actual.rows.map(row=>row.join(','))),new Set(expected));
    // Pinned GEO getBoundary() signs each closed shell independently. On an
    // inner/cavity shell its signs are the opposite of the material cell's
    // outward orientation. Derive that representation from explicit shells,
    // never ignore signs or infer a cavity from coordinates. Actual oriented
    // surface/tet incidence was independently proved by the raw mesh validator.
    const boundary=[],seen=new Set();
    for(const shell of input.domain.cells[c].shells){
      check(typeof shell.outer==='boolean');const patches=new Set(shell.triangleIndexes.map(i=>plan.trianglePatches[i]));
      for(const p of patches){const patch=plan.patches[p],use=patch?.cellUses.find(use=>use.cellIndex===c);check(use!==undefined&&!seen.has(p));seen.add(p);boundary.push((p+1)*use.orientation*(shell.outer?1:-1));}
    }
    check(seen.size===plan.patches.filter(p=>p.cellUses.some(use=>use.cellIndex===c)).length);boundary.sort((a,b)=>a-b);
    const embedded=plan.patches.flatMap((p,i)=>p.constraint.kind==='embedded'&&p.constraint.cellIndexes[0]===c?[[2,i+1]]:[]);
    check(same(actual.entity.boundary,boundary)&&same(actual.entity.embedded,embedded));
  }
  // Node classification affects native optimization even when the coordinates
  // and connectivity match. Prove ownership through the explicit descending
  // boundary/embedding graph, with bounded memoization and graph work.
  const parents=new Map();for(const [id,entity]of entities){const refs=[...entity.boundary.map(n=>[entity.dimension-1,Math.abs(n)]),...entity.embedded];for(const ref of refs){const key=ref.join(':');if(!parents.has(key))parents.set(key,[]);parents.get(key).push(id);}}
  const memo=new Map();let work=0;
  const belongs=(owner,target)=>{
    if(owner===target)return true;const key=owner+'/'+target;if(memo.has(key))return memo.get(key);
    if(memo.size>=2000000)throw new DiscreteTetraError('MESH_CHECKPOINT_LIMIT','检查点节点分类核验超过固定预算，未接纳快照。');
    const pending=[owner],visited=new Set();let found=false;
    while(pending.length){if(++work>20000000)throw new DiscreteTetraError('MESH_CHECKPOINT_LIMIT','检查点拓扑关系核验超过固定预算，未接纳快照。');const id=pending.pop();if(id===target){found=true;break;}if(visited.has(id))continue;visited.add(id);for(const parent of parents.get(id)||[])if(!visited.has(parent))pending.push(parent);}
    memo.set(key,found);return found;
  };
  for(const [id,entity]of entities)for(const n of entity.vertices[0]){const owner=nodes.get(n);check(belongs(owner.dimension+':'+owner.entityTag,id));}
  return {nodes,surfaces,volumes};
}
export function assertCheckpointResult(result,input,requestId){
  try{envelope(result,requestId,'mesh.discrete-checkpoint',P.basis);check(equivalent(result.generationInput,input));fields(result.baseline,rawFields);assertDiscreteTetraResult(legacy(result.baseline,requestId),checkpointBaselineInput(input),requestId);validateMeshCheckpoint(result.checkpoint,result.baseline,input);return result;}catch(error){if(error?.code==='MESH_CHECKPOINT_INVALID')throw error;throw fault();}
}
export function assertOptimizationCheckpointInput(input,context){
  fields(input,['generationInput','checkpointResult']);assertCheckpointInput(input.generationInput,context);const result=input.checkpointResult;assertCheckpointResult(result,input.generationInput,result?.requestId);
  check(result.algorithm?.version===1&&result.algorithm.basis===P.basis&&result.algorithm.gmshVersion===P.gmshVersion&&result.algorithm.apiVersion===P.apiVersion&&result.algorithm.license===P.license&&result.execution?.basis==='single-process-exit-confirmed-v1'&&result.execution.exitCode===0&&result.execution.automaticReplay===false);
  const policy=meshMemoryPolicy({MESH_WORKER_MEMORY_LIMIT_BYTES:String(result.processResources?.processLimitBytes)});assertNativeMemoryGuard({ok:true,protocolVersion:1,service:'gmsh-mesh-worker',capabilities:{version:1,processResources:result.processResources}},policy,'gmsh-mesh-worker');return input;
}
function compareQuality(before,baseline,policy){
  check(before.version===baseline.version&&before.metric===baseline.metric&&before.mode===policy.mode);
  for(const name of ['tetraCount','lowQualityCount','lowQualityFraction','threshold','maxBadFraction','meetsRequestedQuality'])check(before[name]===baseline[name]);check(Math.abs(before.minimumSICN-baseline.minimumSICN)<=2e-10&&before.perCell.length===baseline.perCell.length);
  for(let i=0;i<before.perCell.length;i++){for(const name of ['cellIndex','tetraCount','lowQualityCount','lowQualityFraction','meetsRequestedQuality'])check(before.perCell[i][name]===baseline.perCell[i][name]);check(Math.abs(before.perCell[i].minimumSICN-baseline.perCell[i].minimumSICN)<=2e-10);}
}
export function assertCheckpointBaselineQuality(before,baseline,policy){compareQuality(before,baseline,policy);}
export function assertCheckpointOptimizationResult(result,input,requestId){
  try{
    envelope(result,requestId,'mesh.discrete-optimize',P.optimizationBasis);check(result.restoredExactly===true);fields(result.mesh,rawFields);assertDiscreteTetraResult(legacy(result.mesh,requestId),input.generationInput,requestId);
    check(sortedTags(result.pointNodeTags)&&result.pointNodeTags.length===result.mesh.points.length);const actual=new Map(result.pointNodeTags.map((tag,i)=>[tag,result.mesh.points[i]])),saved=input.checkpointResult,baselineTags=saved.checkpoint.pointNodeTags;
    compareQuality(result.mesh.optimization.before,saved.baseline.quality,input.generationInput.quality);
    for(let i=0;i<saved.baseline.boundaries.length;i++){
      const old=saved.baseline.boundaries[i].triangles.map(row=>row.map(n=>baselineTags[n])),current=result.mesh.boundaries[i].triangles.map(row=>row.map(n=>result.pointNodeTags[n]));check(old.length===current.length);setEqual(new Set(old.map(triangleKey)),new Set(current.map(triangleKey)));
      for(const row of saved.baseline.boundaries[i].triangles)for(const index of row)check(same(actual.get(baselineTags[index]),saved.baseline.points[index]));
    }return result;
  }catch(error){if(error?.code==='MESH_CHECKPOINT_INVALID')throw error;throw fault();}
}
export function checkpointOptimizationFailure(result,input){
  if(result.code==='MESH_QUALITY_REJECTED'){const error=discreteTetraFailure({...result,operation:'mesh.discrete-tetra'},input.generationInput);compareQuality(result.optimization.before,input.checkpointResult.baseline.quality,input.generationInput.quality);return error;}
  check(!['mesh','checkpoint','baseline','points','cells','boundaries'].some(name=>result[name]!==undefined));return new DiscreteTetraError(result.code,result.error.slice(0,1024));
}
