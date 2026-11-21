"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {BackupMaintenanceRecord} from '../../shared/project-backup-maintenance.mjs';
import {modelingController} from '../modeling/runtime';

export function useBackupMaintenance(documentId:string){
  const [records,setRecords]=useState<BackupMaintenanceRecord[]>([]),[selectedId,setSelectedId]=useState<string|null>(null),[loading,setLoading]=useState(false),[pending,setPending]=useState<'preview'|'commit'|'discard'|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[unreadable,setUnreadable]=useState(0);
  const owner=useRef({alive:true,sequence:0,abort:null as AbortController|null,pending:false});
  const owns=useCallback(()=>owner.current.alive&&modelingController.getSnapshot().documentId===documentId,[documentId]);
  const refresh=useCallback(async()=>{
    if(!owns())return;
    const current=owner.current,ticket=++current.sequence;current.abort?.abort();const abort=new AbortController();current.abort=abort;setLoading(true);
    try{const result=await modelingController.listBackupMaintenance(abort.signal);if(owns()&&current.sequence===ticket){setRecords(result.records);setUnreadable(result.unreadableRecords);}}
    catch(reason){if(owns()&&current.sequence===ticket&&!abort.signal.aborted)setError(reason instanceof Error?reason.message:'维护清单暂不可读，请刷新核对。');}
    finally{if(owns()&&current.sequence===ticket)setLoading(false);}
  },[owns]);
  useEffect(()=>{const current=owner.current;current.alive=true;const timer=setTimeout(()=>void refresh(),0);return()=>{clearTimeout(timer);current.alive=false;current.sequence++;current.abort?.abort();};},[refresh]);
  const run=async(kind:'preview'|'commit'|'discard',action:()=>Promise<void>)=>{
    const current=owner.current;if(!owns()||current.pending)return;current.pending=true;setPending(kind);setError(null);setNotice(null);
    try{await action();}catch(reason){if(owns())setError(reason instanceof Error?reason.message:'维护结果尚未确认，请刷新原清单核对。');}
    finally{current.pending=false;if(owns()){setPending(null);await refresh();}}
  };
  const prepare=(entryId:string)=>run('preview',async()=>{setSelectedId(null);const record=await modelingController.previewBackupMaintenance(entryId);if(owns()){setSelectedId(record.reviewId);setRecords(values=>[record,...values.filter(value=>value.reviewId!==record.reviewId)]);setNotice('核对清单已生成，尚未删除材料。请查看文件范围后再决定是否清理。');}});
  const execute=(record:BackupMaintenanceRecord)=>run('commit',async()=>{const result=await modelingController.commitBackupMaintenance(record);if(owns()){setRecords(values=>values.map(value=>value.reviewId===result.record.reviewId?result.record:value));setNotice(result.recovered?'已通过只读查询核对原完成回执，未重复提交清理。':result.record.outcome==='already-absent'?'已核对：原清单中的材料已不存在，未声称本次删除了文件。':'原清单材料已清理；工程几何、属性和建模历史未删除。');}});
  const discard=(record:BackupMaintenanceRecord)=>run('discard',async()=>{await modelingController.discardBackupMaintenance(record.reviewId);if(owns()){setRecords(values=>values.filter(value=>value.reviewId!==record.reviewId));setSelectedId(value=>value===record.reviewId?null:value);setNotice('仅清除了维护清单记录，没有删除任何备份材料。');}});
  const selected=records.find(record=>record.reviewId===selectedId)||null;
  return {records,selected,loading,pending,error,notice,unreadable,refresh,prepare,execute,discard,select:(id:string)=>{setSelectedId(id);setNotice(null);setError(null);},clearError:()=>setError(null)};
}
export type BackupMaintenanceModel=ReturnType<typeof useBackupMaintenance>;
