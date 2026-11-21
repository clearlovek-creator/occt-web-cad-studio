import {createHash} from 'node:crypto';
import {normalizeProjectSaveInput,projectSaveCanonical} from '../shared/project-save-input.mjs';
import {ModelingTaskError} from './modeling-task-service.mjs';
export class ProjectSaveTasks{
  constructor({tasks,backups,workspaceExists,execute}){Object.assign(this,{tasks,backups,workspaceExists,execute});}
  parse(documentId,value){let input;try{input=normalizeProjectSaveInput(value);}catch(error){throw new ModelingTaskError('PROJECT_SAVE_TASK_ARGUMENTS',error.message,400);}if(input.documentId!==documentId)throw new ModelingTaskError('PROJECT_SAVE_TASK_ARGUMENTS','保存任务与工程接口不一致。',400);return input;}
  meta(input){const fingerprint=createHash('sha256').update(projectSaveCanonical(input)).digest('hex');return {documentId:input.documentId,operation:'project.save',requestKey:input.requestId,digest:fingerprint,outcomeFingerprint:fingerprint};}
  describe(record){if(record.operation!=='project.save'||!record.projectSaveInput)throw new ModelingTaskError('PROJECT_SAVE_TASK_NOT_FOUND','任务不是已登记的工程保存。',404);const input=this.tasks.validateProjectSaveBinding(record,record.projectSaveInput);return {modelingTask:this.tasks.get(record.documentId,record.taskId),projectSave:{version:1,taskId:record.taskId,...input,canGenerate:record.ownerInstanceId===this.tasks.ownerInstanceId&&record.phase==='reserved'&&!record.cancelRequested&&!this.tasks.active.has(record.taskId)}};}
  get(documentId,taskId){return this.describe(this.tasks.checked(taskId,documentId));}
  register(documentId,value){const input=this.parse(documentId,value),meta=this.meta(input),previous=[...this.tasks.records.values()].find(record=>record.operation==='project.save'&&record.documentId===documentId&&record.requestKey===input.requestId);if(previous){if(previous.digest!==meta.digest)throw new ModelingTaskError('MODELING_TASK_CONFLICT','原保存任务已绑定其他工程基线。');return this.describe(previous);}if(!this.workspaceExists(documentId))throw new ModelingTaskError('WORKSPACE_NOT_FOUND','待保存工程不存在。',404);const task=this.tasks.reserve(meta,{projectSaveInput:input});return this.get(documentId,task.taskId);}
  outcome(record){
    if(record.operation!=='project.save'||!record.projectSaveInput)return null;const input=this.tasks.validateProjectSaveBinding(record,record.projectSaveInput),manifest=this.backups.read(record.taskId,record.documentId);if(!manifest)return null;if(manifest.fingerprint!==record.outcomeFingerprint||projectSaveCanonical(manifest.input)!==projectSaveCanonical(input))throw new ModelingTaskError('PROJECT_SAVE_RECEIPT_CONFLICT','备份回执与原保存任务不一致。',503);return manifest.result;
  }
  async generate(documentId,taskId,headers,value){
    const record=this.tasks.checked(taskId,documentId);this.describe(record);const input=this.parse(documentId,value),meta=this.meta(input);if(headers['x-request-id']!==input.requestId||record.digest!==meta.digest)throw new ModelingTaskError('MODELING_TASK_CONFLICT','保存提交与原任务身份或基线不一致。');
    const task=this.tasks.claim(taskId,meta),operation=(async()=>{try{return await this.execute(task,input);}catch(error){const result=this.outcome(record);if(result)return {result,notice:'备份已封存，辅助状态记录尚未完成；请下载原备份，不要重新生成。'};throw error;}})();
    const valueResult=await this.tasks.finish(task,operation,value=>value.result);return {...valueResult.result,...this.get(documentId,taskId),...(valueResult.notice?{projectSaveNotice:valueResult.notice}:{})};
  }
}
