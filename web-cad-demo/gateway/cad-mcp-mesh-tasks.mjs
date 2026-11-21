import {meshAgentSummary} from '../shared/mesh-agent-summary.mjs';
import {parseOptimizationRecoveryRequest} from '../shared/mesh-optimization-recovery.mjs';
import {parseMeshRecoveryRequest} from '../shared/mesh-completion-recovery.mjs';

const JOB=/^[A-Za-z0-9_-]{1,120}$/,DOC=/^[A-Za-z0-9_-]{1,64}$/;
const jobId={type:'string',pattern:'^[A-Za-z0-9_-]{1,120}$'},requestId={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',description:'One UUID for this explicit attempt. Retain this exact value in the tool call. After a lost reply, query mesh_jobs__list with this requestId; never invent a new UUID to retry.'},token={type:'string',pattern:'^[a-f0-9]{64}$'};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
export const MESH_MCP_TOOLS=[
  {name:'mesh_jobs__list',readOnly:true,inputSchema:schema({offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:50},requestId}),description:'Read a bounded page of mesh task summaries in this session document only. Filter by a retained requestId to reconcile an unknown optimization/completion request. No generation, repair, derivation or automatic replay. An empty page is NOT proof a lost request did not execute.'},
  {name:'mesh_jobs__get',readOnly:true,inputSchema:schema({jobId},['jobId']),description:'Read one mesh task summary in this session document only. Includes failure/checkpoint identities and recovery availability, never full mesh arrays or local file paths. Completion does not by itself mean the mesh passed admission or is visible.'},
  {name:'mesh_jobs__cancel',readOnly:false,inputSchema:schema({jobId},['jobId']),description:'Explicitly request cancellation of one observed mesh task in this document. Report the returned task state; a timeout or lost reply is unknown, not proof native work stopped. Does not delete original geometry or mesh materials.'},
  {name:'mesh_jobs__resume_optimization',readOnly:false,inputSchema:schema({jobId,requestId,failedStateToken:token,checkpointToken:token},['jobId','requestId','failedStateToken','checkpointToken']),description:'Only when the user requests it: start one independent optimization attempt from a failed task checkpoint. Copy both tokens from mesh_jobs__get. Preserve the original failure, never regenerate/relax quality/automatically derive or display. Accepted is NOT completed. Keep the UUID; after an unknown reply use read-only requestId lookup, not a new attempt.'},
  {name:'mesh_jobs__recover_completion',readOnly:false,inputSchema:schema({jobId,requestId,failedStateToken:token},['jobId','requestId','failedStateToken']),description:'Only when explicitly requested: revalidate retained results of an uncommitted completion and recover its receipt. Copy the failedStateToken from mesh_jobs__get. Does not rerun meshing or optimization. Keep the UUID and reconcile unknown replies by read-only requestId lookup.'},
];
const fail=(code,message,extra={})=>Object.assign(Error(message),{code,retryableByModel:false,...extra});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function argumentsFor(tool,args){
  const keys=Object.keys(tool.inputSchema.properties);
  if(!plain(args)||Object.keys(args).some(key=>!keys.includes(key))||tool.inputSchema.required.some(key=>!Object.hasOwn(args,key)))throw fail('MCP_MESH_ARGUMENT_INVALID','网格工具参数缺失或包含不支持的字段。',{outcome:'not-started'});
  if(tool.name==='mesh_jobs__list'){
    for(const [key,min,max] of [['offset',0,100000],['limit',1,50]])if(args[key]!==undefined&&(!Number.isSafeInteger(args[key])||args[key]<min||args[key]>max))throw fail('MCP_MESH_ARGUMENT_INVALID','网格分页范围无效。',{outcome:'not-started'});
    if(args.requestId!==undefined&&!new RegExp(requestId.pattern).test(args.requestId))throw fail('MCP_MESH_ARGUMENT_INVALID','恢复请求编号无效。',{outcome:'not-started'});
  }else if(typeof args.jobId!=='string'||!JOB.test(args.jobId))throw fail('MCP_MESH_ARGUMENT_INVALID','网格任务编号无效。',{outcome:'not-started'});
  if(tool.name==='mesh_jobs__resume_optimization')parseOptimizationRecoveryRequest({requestId:args.requestId,failedStateToken:args.failedStateToken,checkpointToken:args.checkpointToken});
  if(tool.name==='mesh_jobs__recover_completion')parseMeshRecoveryRequest({requestId:args.requestId,failedStateToken:args.failedStateToken});
}
async function json(fetchImpl,url,init,signal,timeoutMs){
  const controller=new AbortController();let reader,timer,expired=false;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;controller.abort();reject(Error('Mesh observation deadline'));},timeoutMs);});
  let abort;const cancelled=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(Error('Mesh observation cancelled'));};signal?.addEventListener('abort',abort,{once:true});});
  const observe=promise=>Promise.race([promise,deadline,cancelled]);
  try{
    if(signal?.aborted)throw Error('Mesh observation cancelled');
    const work=Promise.resolve().then(()=>fetchImpl(url,{...init,redirect:'error',signal:controller.signal}));void work.then(response=>{if(expired||controller.signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
    const response=await observe(work),length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>256*1024))throw Error('Mesh response exceeds budget');
    reader=response.body?.getReader();if(!reader)throw Error('Empty mesh response');const chunks=[];let size=0,fragments=0;
    for(;;){const {done,value}=await observe(reader.read());if(done)break;size+=value.byteLength;if(size>256*1024||++fragments>4096)throw Error('Mesh response exceeds budget');chunks.push(value);}
    const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));if(!plain(payload)||typeof payload.ok!=='boolean')throw Error('Invalid mesh response');return {response,payload};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
}
export async function callMeshMcpTool({tool,args,root,documentId,fetchImpl=fetch,signal,timeoutMs=10000}){
  if(!DOC.test(documentId||'')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw fail('MCP_MESH_ARGUMENT_INVALID','网格会话或观察时限无效。',{outcome:'not-started'});
  try{argumentsFor(tool,args);}catch(error){throw fail(error.code||'MCP_MESH_ARGUMENT_INVALID',error.message,{outcome:'not-started'});}
  if(signal?.aborted)throw fail('MCP_CANCELLED_BEFORE_SEND','调用已取消，网格请求未发送。',{outcome:'not-started'});
  const collection=root+'/documents/'+encodeURIComponent(documentId)+'/mesh/jobs',list=tool.name==='mesh_jobs__list',readOnly=tool.readOnly;
  const action=tool.name==='mesh_jobs__resume_optimization'?'resume-optimization':tool.name==='mesh_jobs__recover_completion'?'recover-completion':tool.name==='mesh_jobs__cancel'?'cancel':'';
  const body=action==='cancel'?{}:action==='resume-optimization'?{requestId:args.requestId,failedStateToken:args.failedStateToken,checkpointToken:args.checkpointToken}:{requestId:args.requestId,failedStateToken:args.failedStateToken};
  const identity={documentId,...(!list?{jobId:args.jobId}:{}),...(action?{action}:{}),...(args.requestId?{requestId:args.requestId}:{})};
  const query=new URLSearchParams({summary:'1',offset:String(args.offset??0),limit:String(args.limit??20),...(args.requestId?{requestId:args.requestId}:{})});
  const url=list?collection+'?'+query:collection+'/'+encodeURIComponent(args.jobId)+(action?'/'+action:'');
  try{
    const {response,payload}=await json(fetchImpl,url,readOnly?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},signal,timeoutMs);
    if(!response.ok||!payload.ok)throw fail(typeof payload.code==='string'?payload.code:'MCP_MESH_REQUEST_FAILED',typeof payload.error==='string'?payload.error.slice(0,500):'网格请求被拒绝。',{outcome:readOnly?'unchanged':response.status===400?'not-started':'unknown'});
    if(payload.documentId!==documentId)throw Error('Mesh document binding differs');
    const summary=(value,id)=>{if(value?.version!==1||typeof value.visible!=='boolean'||typeof value.requestedVisible!=='boolean')throw Error('Mesh summary protocol differs');return meshAgentSummary(value,documentId,id);};
    if(list){
      const page=payload.page;if(payload.version!==1||!plain(page)||page.offset!==(args.offset??0)||page.limit!==(args.limit??20)||!Number.isSafeInteger(page.total)||page.total<0||!Array.isArray(payload.jobs)||payload.jobs.length>page.limit||page.nextOffset!==(Math.min(page.total,page.offset+page.limit)<page.total?Math.min(page.total,page.offset+page.limit):null)||payload.jobs.length!==Math.max(0,Math.min(page.limit,page.total-page.offset)))throw Error('Mesh page binding differs');
      const jobs=payload.jobs.map(value=>summary(value,value?.jobId));if(new Set(jobs.map(job=>job.jobId)).size!==jobs.length||args.requestId&&jobs.some(job=>![job.optimizationAttempt?.requestId,job.completionRecovery?.requestId].includes(args.requestId)))throw Error('Mesh request lookup differs');
      return {ok:true,status:'observed',documentId,page,jobs,emptyIsNotExecutionProof:true};
    }
    const meshJob=summary(payload.meshJob,action==='resume-optimization'?payload.meshJob?.jobId:args.jobId);
    if(action==='resume-optimization'){const attempt=meshJob.optimizationAttempt;if(!attempt||attempt.requestId!==args.requestId||attempt.originHandle!==args.jobId||attempt.failedStateToken!==args.failedStateToken||attempt.checkpointToken!==args.checkpointToken)throw Error('Mesh optimization receipt differs');}
    if(action==='recover-completion'&&(meshJob.completionRecovery?.requestId!==args.requestId||meshJob.completionRecovery?.failedStateToken!==args.failedStateToken))throw Error('Mesh completion receipt differs');
    return {ok:true,status:readOnly?'observed':'accepted',documentId,meshJob,...(!readOnly?{meshRequest:identity}:{}),automaticReplay:false};
  }catch(error){
    throw fail(error.code||'MCP_MESH_OUTCOME_UNCONFIRMED',error.code?error.message:readOnly?'网格概要读取失败。':'网格操作结果尚未确认；先按原请求编号查询，不会自动重发或新建尝试。',{outcome:error.outcome||(readOnly?'unchanged':'unknown'),...(!readOnly?{meshRequest:identity}:{}),recovery:'Use mesh_jobs__get for the original job and mesh_jobs__list with the SAME requestId. Empty results do not prove the request was not accepted. Do not submit a new requestId as a retry.'});
  }
}
