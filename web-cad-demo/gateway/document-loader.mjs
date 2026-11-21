export class DocumentLoadError extends Error {
  constructor(code,message){super(message);this.name='DocumentLoadError';this.code=code;}
}

/** One native restoration path. Progress is transient; durable truth stays in historyStore. */
export class DocumentLoader {
  constructor({historyStore,restore,applyProjectData,recoverCheckpoint,onProgress=()=>{},now=Date.now}){
    Object.assign(this,{historyStore,restore,applyProjectData,recoverCheckpoint,onProgress,now});
    this.loaded=new Set();this.pending=new Map();this.records=new Map();this.generation=0;
  }
  invalidate(){
    this.generation++;this.loaded.clear();this.pending.clear();
    for(const [id,record] of this.records)if(record.state!=='failed')this.records.set(id,{state:'unloaded',phase:'waiting',interrupted:record.state==='loading',error:record.state==='loading'?'几何进程中断，未确认完成的工程将按需重新加载。':null});
  }
  markReady(id){this.loaded.add(id);const old=this.records.get(id);this.records.set(id,{state:'ready',phase:'ready',durationMs:old?.startedAt?this.now()-old.startedAt:old?.durationMs||0,updatedAt:this.now(),recovered:old?.recovered||false});}
  status(id){
    const history=this.historyStore.get(id),record=this.records.get(id);
    if(history.restoreError)return {state:'failed',phase:'failed',error:history.restoreError};
    if(this.loaded.has(id))return record?.state==='ready'?{...record}:{state:'ready',phase:'ready'};
    if(record?.state==='failed')return {...record};
    return record?.state==='loading'?{...record,elapsedMs:Math.max(0,this.now()-record.startedAt)}:{state:'unloaded',phase:'waiting',...(record?.error?{error:record.error,interrupted:true}:{})};
  }
  counts(ids){const counts={known:ids.length,unloaded:0,loading:0,ready:0,failed:0};for(const id of ids)counts[this.status(id).state]++;return counts;}
  ensure(id){
    if(this.loaded.has(id))return Promise.resolve();
    if(this.pending.has(id))return this.pending.get(id);
    const generation=this.generation,startedAt=this.now();
    const check=()=>{if(this.generation!==generation)throw new DocumentLoadError('DOCUMENT_LOAD_INTERRUPTED','几何进程已变化，本次加载未采用；请重新打开工程。');};
    const progress=(phase,extra={})=>{check();this.records.set(id,{state:'loading',phase,startedAt,...extra});this.onProgress(id,phase);};
    const run=Promise.resolve().then(async()=>{
      const history=this.historyStore.get(id);
      if(history.restoreError)throw new DocumentLoadError('HISTORY_RESTORE_FAILED',history.restoreError);
      progress('checking');
      if(!history.current){check();this.markReady(id);return;}
      const candidates=[...new Set([history.current,...history.undo.toReversed(),...history.redo.toReversed()])];
      let lastError='工程检查点无法读取，未以空工程替代。';
      for(let index=0;index<candidates.length;index++){
        check();const candidate=candidates[index];progress('checking',{attempt:index+1});
        if(!this.historyStore.isValidSnapshot(id,candidate)){lastError='工程检查点文件或关联属性校验失败，原文件已保留。';continue;}
        let schema;try{schema=this.historyStore.readProjectData(id,candidate);}catch(error){lastError=error.message;continue;}
        progress('restoring-geometry',{attempt:index+1});
        // A transport failure is not proof of corrupt geometry. Never walk back
        // the timeline, mark it damaged, or replay a write after a timeout/crash.
        const result=await this.restore(id,candidate);check();
        if(!result?.ok){lastError=result?.error||'内核拒绝读取工程检查点。';continue;}
        progress('restoring-project-data',{attempt:index+1});
        try{
          if(candidate!==history.current)await this.recoverCheckpoint(id,history,candidate,result,schema);
          else if(schema)await this.applyProjectData(id,schema);
        }catch(error){throw new DocumentLoadError('PROJECT_DATA_RESTORE_FAILED','工程数据恢复未完成，原始检查点已保留：'+error.message);}
        check();this.records.set(id,{state:'loading',phase:'finalizing',startedAt,recovered:candidate!==history.current});this.markReady(id);return;
      }
      this.historyStore.markRestoreError(id,lastError);throw new DocumentLoadError('HISTORY_RESTORE_FAILED',lastError);
    }).catch(error=>{
      if(this.generation!==generation)throw new DocumentLoadError('DOCUMENT_LOAD_INTERRUPTED','几何进程已变化，本次加载未采用；请重新打开工程。');
      const permanent=error instanceof DocumentLoadError&&['HISTORY_RESTORE_FAILED','PROJECT_DATA_RESTORE_FAILED'].includes(error.code);
      this.records.set(id,{state:permanent?'failed':'unloaded',phase:permanent?'failed':'waiting',error:error.message,durationMs:this.now()-startedAt,interrupted:!permanent});
      throw error;
    }).finally(()=>{if(this.pending.get(id)===run)this.pending.delete(id);});
    this.pending.set(id,run);return run;
  }
}
