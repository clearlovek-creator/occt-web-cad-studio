import type {MeshAdmission} from './model/mesh';
import {meshAdmissionLabel} from '../shared/mesh-admission.mjs';
import type {ReactNode} from 'react';

export function MeshAdmissionPanel({report,children}:{report?:MeshAdmission|null;children?:ReactNode}){
  return <section className={`mesh-admission ${report?.status||'unverified'}`} role="status" aria-label="网格验收" data-status={report?.status||'unverified'}>
    <strong>{meshAdmissionLabel(report)}</strong>
    <span>{report?.spatial?'数值质量 · 连接拓扑 · 线性空间检查 · 体覆盖 · 来源映射':'数值质量 · 连接拓扑 · 体覆盖 · 来源映射'}</span>
    {report?<><dl><div><dt>有网格的体</dt><dd>{report.counts.meshedVolumeCount} / {report.counts.volumeCount}</dd></div><div><dt>四面体</dt><dd>{report.counts.tetraCount}</dd></div><div><dt>反转 / 退化</dt><dd>{report.counts.invertedCount} / {report.counts.degenerateCount}</dd></div><div><dt>阈值以下</dt><dd>{report.counts.lowQualityCount}</dd></div></dl>
      {report.reasons.length>0&&<details><summary>验收详情 · {report.reasons.length} 项</summary><ul>{report.reasons.map(reason=><li key={reason.code}><strong>{reason.severity==='error'?'阻止使用':reason.severity==='warning'?'警告':'缺少证据'}</strong> · {reason.message}{reason.count>1?`（${reason.count}）`:''}</li>)}</ul></details>}
    </>:<p>旧结果尚无可验证的验收记录，请载入结果进行核对或重新剖分。</p>}
    {children}
  </section>;
}
