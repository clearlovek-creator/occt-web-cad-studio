import {createHash} from 'node:crypto';
import {normalizeProjectCreateInput,projectCreateCanonical} from '../shared/project-create-input.mjs';
import {ModelingTaskError} from './modeling-task-service.mjs';
const fault=(code,message,status=409)=>new ModelingTaskError(code,message,status);
const terminal=new Set(['succeeded','failed','cancelled']);
/** A fresh target is reserved once; existing projects are never reset by this workflow. */
export class ProjectCreateTasks{
  constructor({tasks,sourceExists,targetExists,execute}){Object.assign(this,{tasks,sourceExists,targetExists,execute});}
  parse(documentId,value){let input;try{input=normalizeProjectCreateInput(value);}catch(error){throw fault('PROJECT_CREATE_TASK_ARGUMENTS',error.message,400);}if(input.documentId!==documentId)throw fault('PROJECT_CREATE_TASK_ARGUMENTS','新建任务目标与接口不一致。',400);return input;}
  meta(input){const fingerprint=createHash('sha256').update(projectCreateCanonical(input)).digest('hex');return {documentId:input.documentId,operation:'project.create',requestKey:input.requestId,digest:fingerprint,outcomeFingerprint:fingerprint};}
  describe(record){
    if(record.operation!=='project.create'||!record.projectCreateInput)throw fault('PROJECT_CREATE_TASK_NOT_FOUND','不是已登记的新建工程任务。',404);
    const input=this.tasks.validateProjectCreateBinding(record,record.projectCreateInput);
    return {modelingTask:this.tasks.get(record.documentId,record.taskId),projectCreate:{version:1,taskId:record.taskId,...input,canCreate:record.ownerInstanceId===this.tasks.ownerInstanceId&&record.phase==='reserved'&&!record.cancelRequested&&!this.tasks.active.has(record.taskId)}};
  }
  get(documentId,taskId){return this.describe(this.tasks.checked(taskId,documentId));}
  register(documentId,value){
    const input=this.parse(documentId,value),meta=this.meta(input),previous=[...this.tasks.records.values()].find(record=>record.documentId===documentId&&record.operation==='project.create');
    if(previous){if(previous.requestKey!==input.requestId||previous.digest!==meta.digest)throw fault('MODELING_TASK_CONFLICT','目标已绑定另一份新建请求，不会复用目标或重置工程。');return this.describe(previous);}
    if(!this.sourceExists(input.sourceDocumentId))throw fault('PROJECT_CREATE_SOURCE_NOT_FOUND','发起新建操作的工程不存在。',404);
    if(this.targetExists(documentId))throw fault('PROJECT_CREATE_TARGET_EXISTS','目标工程或恢复材料已存在，不能作为全新工程覆盖。');
    const task=this.tasks.reserve(meta,{projectCreateInput:input});return this.get(documentId,task.taskId);
  }
  list(sourceDocumentId,{limit=50,after}={}){
    if(typeof sourceDocumentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(sourceDocumentId)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw fault('PROJECT_CREATE_TASK_ARGUMENTS','新建工程任务列表参数无效。',400);
    const records=[...this.tasks.records.values()].filter(record=>record.operation==='project.create'&&record.projectCreateInput?.sourceDocumentId===sourceDocumentId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.taskId.localeCompare(a.taskId));
    const start=after===undefined?0:records.findIndex(record=>record.taskId===after)+1;if(after!==undefined&&(!/^[a-f0-9-]{36}$/.test(after)||start===0))throw fault('PROJECT_CREATE_CURSOR_EXPIRED','新建任务分页游标已变化，请重新读取列表。');
    const end=Math.min(start+limit,records.length),items=records.slice(start,end).map(record=>this.describe(record)),projected=new Map(items.map(row=>[row.modelingTask.taskId,row]));
    const active=records.filter(record=>record.ownerInstanceId===this.tasks.ownerInstanceId&&!terminal.has(record.phase)&&record.phase!=='unknown').map(record=>projected.get(record.taskId)||this.describe(record));
    const attention=records.filter(record=>projected.has(record.taskId)&&terminal.has(projected.get(record.taskId).modelingTask.phase)?false:record.phase==='unknown'||record.ownerInstanceId!==this.tasks.ownerInstanceId&&!terminal.has(record.phase)).map(record=>({taskId:record.taskId,documentId:record.documentId,needsRead:true}));
    return {sourceDocumentId,total:records.length,items,nextCursor:end<records.length?records[end-1].taskId:null,active,attention};
  }
  async create(documentId,taskId,headers,value){
    const record=this.tasks.checked(taskId,documentId);this.describe(record);const input=this.parse(documentId,value),meta=this.meta(input);
    if(headers['x-request-id']!==input.requestId||record.digest!==meta.digest)throw fault('MODELING_TASK_CONFLICT','新建提交与原任务身份、名称或来源状态不一致。');
    const task=this.tasks.claim(taskId,meta),pending=(async()=>{try{return await this.execute(task,input);}catch(error){if(task.mode==='preparing'&&!error?.projectRollback)try{Object.defineProperty(error,'projectCreateNotStarted',{value:{documentId,confirmed:true}});}catch{/* Keep immutable failures conservative. */}throw error;}})();
    const valueResult=await this.tasks.finish(task,pending,value=>value.result);
    return {...valueResult.result,...this.get(documentId,taskId),...(valueResult.notice?{projectCreateNotice:valueResult.notice}:{})};
  }
}
