import {parseOptimizationRecoveryInfo,parseOptimizationAttempt} from './mesh-optimization-recovery.mjs';
import {parseMeshRecoveryInfo} from './mesh-completion-recovery.mjs';

const DOC=/^[A-Za-z0-9_-]{1,64}$/,JOB=/^[A-Za-z0-9_-]{1,120}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=()=>Object.assign(Error('网格任务概要或分页身份无效。'),{code:'MESH_AGENT_SUMMARY_INVALID'});
const text=(value,limit)=>typeof value==='string'?value.replace(/[\x00-\x1f]/g,' ').slice(0,limit):'';
export function meshAgentSummary(job,documentId=job?.documentId,jobId=job?.jobId){
  if(!job||typeof documentId!=='string'||!DOC.test(documentId)||typeof jobId!=='string'||!JOB.test(jobId)||job.documentId!==documentId||job.jobId!==jobId||typeof job.state!=='string'||!job.state||job.state.length>32||typeof job.kind!=='string'||job.kind.length>40||job.revision!==null&&(!Number.isSafeInteger(job.revision)||job.revision<0))throw fail();
  return {version:1,documentId,jobId,kind:job.kind,state:job.state,revision:job.revision,
    createdAt:text(job.createdAt,40),visible:job.visible===true,requestedVisible:job.requestedVisible===true,
    freshness:{status:text(job.freshness?.status,32),reason:text(job.freshness?.reason,300)},
    admission:job.admission?{status:text(job.admission.status,32)}:null,
    ...(job.derivation?{derivation:{state:text(job.derivation.state,32),canStart:job.derivation.canStart===true,defaultVisible:false}}:{}),
    ...(job.optimizationRecovery?{optimizationRecovery:parseOptimizationRecoveryInfo(job.optimizationRecovery)}:{}),
    ...(job.optimizationAttempt?{optimizationAttempt:parseOptimizationAttempt(job.optimizationAttempt)}:{}),
    ...(job.completionRecovery?{completionRecovery:parseMeshRecoveryInfo(job.completionRecovery)}:{}),
    ...(job.errorCode?{errorCode:text(job.errorCode,80)}:{}),...(job.error?{error:text(job.error,500)}:{})};
}
export function meshAgentPageQuery(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['summary','offset','limit','requestId'].includes(key))||input.summary!=='1')throw fail();
  const integer=(value,fallback,max)=>{if(value===undefined)return fallback;if(!/^(0|[1-9][0-9]*)$/.test(String(value)))throw fail();const number=Number(value);if(!Number.isSafeInteger(number)||number>max)throw fail();return number;};
  const offset=integer(input.offset,0,100000),limit=integer(input.limit,20,50);if(limit<1||input.requestId!==undefined&&(typeof input.requestId!=='string'||!UUID.test(input.requestId)))throw fail();
  return {offset,limit,...(input.requestId?{requestId:input.requestId}:{})};
}
