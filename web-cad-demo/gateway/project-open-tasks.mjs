import {createHash} from 'node:crypto';
import {normalizeProjectOpenInput,projectOpenCanonical} from '../shared/project-open-input.mjs';
import {ModelingTaskError} from './modeling-task-service.mjs';
const fault=(code,message,status=409)=>new ModelingTaskError(code,message,status);
const terminal=new Set(['succeeded','failed','cancelled']);
/** File binding is atomically persisted in the existing task record. No second queue. */
export class ProjectOpenTasks{
  constructor({tasks,inputs,maxBytes,targetExists,sourceExists,execute}){Object.assign(this,{tasks,inputs,maxBytes:Math.min(maxBytes,inputs.maxBytes??maxBytes,1024**3),targetExists,sourceExists,execute});}
  parse(documentId,value){let input;try{input=normalizeProjectOpenInput(value,this.maxBytes);}catch(error){throw fault('PROJECT_OPEN_TASK_ARGUMENTS',error.message,400);}if(input.documentId!==documentId)throw fault('PROJECT_OPEN_TASK_ARGUMENTS','任务目标工程与接口不一致。',400);return input;}
  meta(input){const digest=createHash('sha256').update(projectOpenCanonical(input)).digest('hex');return {documentId:input.documentId,operation:'project.open',requestKey:input.requestId,digest,outcomeFingerprint:digest};}
  describe(record){
    if(record.operation!=='project.open'||!record.projectOpenInput)throw fault('PROJECT_OPEN_TASK_NOT_FOUND','任务不是已登记的工程文件打开操作。',404);
    const input=this.tasks.validateProjectOpenBinding(record,record.projectOpenInput);
    return {modelingTask:this.tasks.get(record.documentId,record.taskId),projectOpen:{version:1,taskId:record.taskId,...input,canUpload:record.ownerInstanceId===this.tasks.ownerInstanceId&&record.phase==='reserved'&&!record.cancelRequested&&!this.tasks.active.has(record.taskId)}};
  }
  get(documentId,taskId){return this.describe(this.tasks.checked(taskId,documentId));}
  register(documentId,value){
    const input=this.parse(documentId,value),meta=this.meta(input);
    const previous=[...this.tasks.records.values()].find(record=>record.documentId===documentId&&record.operation==='project.open');
    if(previous){if(previous.requestKey!==input.requestId||previous.digest!==meta.digest)throw fault('MODELING_TASK_CONFLICT','目标工程已绑定另一次打开请求，未接收新文件。');return this.describe(previous);}
    if(!this.sourceExists(input.sourceDocumentId))throw fault('PROJECT_OPEN_SOURCE_NOT_FOUND','发起打开操作的工程不存在。',404);
    if(this.targetExists(documentId))throw fault('PROJECT_OPEN_TARGET_EXISTS','目标工程已存在，不能用文件任务覆盖。');
    const task=this.tasks.reserve(meta,{projectOpenInput:input});return this.get(documentId,task.taskId);
  }
  list(sourceDocumentId,{limit=50,after}={}){
    if(typeof sourceDocumentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(sourceDocumentId)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw fault('PROJECT_OPEN_TASK_ARGUMENTS','工程文件任务列表参数无效。',400);
    const records=[...this.tasks.records.values()].filter(record=>record.operation==='project.open'&&record.projectOpenInput?.sourceDocumentId===sourceDocumentId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.taskId.localeCompare(a.taskId));
    const start=after===undefined?0:records.findIndex(record=>record.taskId===after)+1;if(after!==undefined&&(!/^[a-f0-9-]{36}$/.test(after)||start===0))throw fault('PROJECT_OPEN_CURSOR_EXPIRED','任务列表游标已变化，请重新读取列表。');
    const end=Math.min(start+limit,records.length),items=records.slice(start,end).map(record=>this.describe(record)),projected=new Map(items.map(row=>[row.modelingTask.taskId,row]));
    const active=records.filter(record=>record.ownerInstanceId===this.tasks.ownerInstanceId&&!terminal.has(record.phase)&&record.phase!=='unknown').map(record=>projected.get(record.taskId)||this.describe(record));
    const attention=records.filter(record=>projected.has(record.taskId)&&terminal.has(projected.get(record.taskId).modelingTask.phase)?false:record.phase==='unknown'||record.ownerInstanceId!==this.tasks.ownerInstanceId&&!terminal.has(record.phase)).map(record=>({taskId:record.taskId,documentId:record.documentId,needsRead:true}));
    return {sourceDocumentId,total:records.length,items,nextCursor:end<records.length?records[end-1].taskId:null,active,attention};
  }
  async upload(documentId,taskId,headers,request){
    const record=this.tasks.checked(taskId,documentId);this.describe(record);const input=this.tasks.validateProjectOpenBinding(record,record.projectOpenInput);let fileName;try{fileName=decodeURIComponent(headers['x-file-name']);}catch{throw fault('PROJECT_OPEN_TASK_ARGUMENTS','工程文件名编码无效。',400);}
    if(headers['x-request-id']!==input.requestId||fileName!==input.fileName||headers['content-length']!==undefined&&headers['content-length']!==String(input.expectedBytes))throw fault('MODELING_TASK_CONFLICT','工程文件上传与原登记身份、文件名或长度不一致。');
    const task=this.tasks.claim(taskId,this.meta(input),{receiving:true});
    const operation=(async()=>{let staged,retain=false;try{
      staged=await this.inputs.receive(request,{maxBytes:this.maxBytes,declaredBytes:input.expectedBytes,signal:task.controller.signal});this.tasks.enterQueued(task);
      return await this.execute(task,input,staged);
    }catch(error){
      retain=error?.projectRollback?.confirmed!==true&&['executing','stopping','rolling-back','committing'].includes(task.mode);
      if(task.mode==='preparing'&&!error?.projectRollback)try{Object.defineProperty(error,'projectOpenNotStarted',{value:{documentId,confirmed:true}});}catch{/* No unproven claim for immutable failures. */}
      throw error;
    }finally{await staged?.release({retain});}})();
    const value=await this.tasks.finish(task,operation,value=>value.result);
    return {...value.result,...this.get(documentId,taskId),...(value.notice?{projectOpenNotice:value.notice}:{})};
  }
}
