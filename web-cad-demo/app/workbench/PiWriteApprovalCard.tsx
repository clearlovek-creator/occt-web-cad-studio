"use client";

import {useCallback, useEffect, useRef, useState} from 'react';
import {API_ROOT} from '../api-config';

export type PiApprovalBinding = {sessionId:string; documentId:string; streamId:string};
type ApprovalStatus = 'pending' | 'approved' | 'submitted' | 'cancelled' | 'expired' | 'stale';
type Approval = {
  id:string; documentId:string; streamId:string; operation:string;
  status:ApprovalStatus; expiresAt:number; revision?:number; notice?:string;
  steps?: {operation:string; label:string; targets:{id:string; name:string; action:string; role?:string}[]}[];
};
const labels: Record<ApprovalStatus,string> = {
  pending:'等待确认', approved:'已确认，等待执行', submitted:'已交付执行，结果见工具回执',
  cancelled:'已取消', expired:'确认已过期', stale:'工程已变化，确认已失效',
};

export function PiWriteApprovalCard({sessionId, documentId, streamId, disabled}: PiApprovalBinding & {disabled:boolean}) {
  const query = new URLSearchParams({documentId,streamId});
  const endpoint = `${API_ROOT}/pi/sessions/${encodeURIComponent(sessionId)}/write-approval?${query}`;
  const [approval,setApproval] = useState<Approval|null>(null);
  const [notice,setNotice] = useState('');
  const [deciding,setDeciding] = useState(false);
  const decision = useRef(false), version = useRef(0);
  const read = useCallback(async (signal:AbortSignal, selected?:{id:string; decision:'approve'|'cancel'}) => {
    const response = await fetch(endpoint,{
      cache:'no-store', signal, redirect:'error',
      ...(selected ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(selected)} : {}),
    });
    const value = await response.json();
    if (!response.ok || value?.ok !== true) throw new Error(value?.error || '助手确认暂不可用。');
    if (value.documentId !== documentId || value.streamId !== streamId ||
        (value.approval !== null && (value.approval?.documentId !== documentId || value.approval?.streamId !== streamId)))
      throw new Error('确认结果与当前工程或会话不匹配。');
    return value.approval as Approval|null;
  },[endpoint,documentId,streamId]);
  // Restart the poll with the owning stream. A decision response takes priority
  // over a read that started before the click.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const observed = version.current;
      try {
        if (!decision.current) {
          const result = await read(AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]));
          if (!controller.signal.aborted && observed === version.current) setApproval(result);
        }
      } catch {
        if (!controller.signal.aborted && observed === version.current)
          setApproval(current => current?.status === 'pending' ? null : current);
      } finally {
        if (!controller.signal.aborted) timer=setTimeout(poll,1000);
      }
    }
    void poll();
    return () => {controller.abort();clearTimeout(timer);};
  },[read]);

  const choose = async (value:'approve'|'cancel') => {
    if (!approval || approval.status !== 'pending' || disabled || decision.current) return;
    decision.current=true;
    version.current++;
    setDeciding(true);
    setNotice('');
    try {
      setApproval(await read(AbortSignal.timeout(10000),{id:approval.id,decision:value}));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '决定暂未确认，请查看当前状态。');
    } finally {
      decision.current=false;
      setDeciding(false);
    }
  };
  if (!approval && !notice) return null;
  return <section className="pi-write-approval" aria-label="助手写入确认" data-testid="pi-write-approval" data-status={approval?.status}>
    {approval && <>
      <div className="pi-write-approval-heading"><strong>{approval.operation === 'project.batch' ? '批量修改 Body' : approval.steps?.[0]?.label || '确认助手操作'}</strong><span role="status">{labels[approval.status]}</span></div>
      {approval.status === 'pending' && <>
        <p>工程 {approval.documentId} · 修订 R{approval.revision}</p>
        <ol aria-label="受影响的 Body">
          {approval.steps?.map((step,index) => <li key={index}>
            {approval.operation === 'project.batch' && <strong>{step.label}</strong>}
            <ul>{step.targets.map(target => <li key={target.id}>
              <strong>{target.name}</strong> <span>{target.id} · {target.role ? `${target.role} · ` : ''}{target.action}</span>
            </li>)}</ul>
          </li>)}
        </ol>
        <div className="pi-write-approval-actions">
          <button type="button" disabled={disabled||deciding} onClick={()=>void choose('cancel')}>取消操作</button>
          <button type="button" disabled={disabled||deciding} onClick={()=>void choose('approve')}>确认执行</button>
        </div>
      </>}
      {approval.notice && <p>{approval.notice}</p>}
    </>}
    {notice && <p role="alert">{notice}</p>}
  </section>;
}
