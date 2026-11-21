"use client";
import {meshCatalogReason,type MeshCatalogSnapshot} from './model/mesh-catalog';

type Props={catalog:MeshCatalogSnapshot;pending:boolean;loading:boolean;uncertain:boolean;error:string;onRecover:()=>void};
export function MeshCatalogNotice({catalog,pending,loading,uncertain,error,onRecover}:Props){
  if(catalog.state==='ready'&&!uncertain||catalog.state==='unknown')return null;
  const observing=(pending||loading)&&!uncertain;
  const title=uncertain?'网格历史读取结果待核对':catalog.state==='recovering'?'正在读取网格历史':catalog.state==='stopped'?'网格服务正在停止':'网格历史未就绪';
  return <div className="mesh-catalog-notice" data-testid="mesh-catalog-notice" data-state={catalog.state} role="status" aria-live="polite" aria-busy={observing}>
    <h3>{title}</h3>
    <p>{uncertain?'读取回复未确认。先核对后台状态，不会自动重复发起恢复。':catalog.state==='recovering'?'完整读取完成后才显示任务数量。可继续建模或关闭本工具，后台不会重新剖分。':catalog.state==='stopped'?'请等待服务停止完成，现有工程和网格结果均保留。':meshCatalogReason(catalog.code)}</p>
    <p className="mesh-catalog-preserved">不会修改几何、覆盖旧网格或重做剖分；当前参数保留。</p>
    {(catalog.canRetry||uncertain)&&<button type="button" className="secondary-action" disabled={pending||loading} onClick={onRecover}>{pending?'正在核对历史…':uncertain?'核对读取状态':'重新读取网格历史'}</button>}
    {(catalog.code||uncertain&&error)&&<details><summary>技术信息</summary>{catalog.code&&<code>{catalog.code}</code>}{uncertain&&error&&<p>{error}</p>}</details>}
  </div>;
}
