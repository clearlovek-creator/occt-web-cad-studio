"use client";
import { useEffect, useState } from "react";
import { API_ROOT } from "../api-config";
import { documentLoadLabel, parseDocumentLoad, type DocumentLoadState } from "../modeling/document-load";

export function ProjectLoadStatus({ documentId, active }: { documentId: string; active: boolean }) {
  const [observed, setObserved] = useState<{ documentId: string; load: DocumentLoadState | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!active) return;
    let stopped = false, next: ReturnType<typeof setTimeout> | undefined;
    let abort: AbortController | null = null;
    const poll = async () => {
      abort = new AbortController();
      const timeout = setTimeout(() => abort?.abort(), 5000);
      let ready = false;
      try {
        const response = await fetch(`${API_ROOT}/documents/${encodeURIComponent(documentId)}/load-status`, { signal: abort.signal });
        const payload = await response.json(), load = parseDocumentLoad(payload.load);
        if (!response.ok || !payload.ok || payload.documentId !== documentId || !load) throw new Error("状态查询暂不可用，原加载请求仍在处理，请勿重复提交。");
        if (!stopped) setObserved({ documentId, load, error: null });
        ready = load.state === "ready" || load.state === "failed";
      } catch { if (!stopped) setObserved({ documentId, load: null, error: "无法读取加载进度；原请求不会自动重发，请等待当前请求结果。" }); }
      finally { clearTimeout(timeout); if (!stopped && !ready) next = setTimeout(() => void poll(), 750); }
    };
    void poll();
    return () => { stopped = true; abort?.abort(); clearTimeout(next); };
  }, [documentId, active]);
  if (!active) return null;
  const current = observed?.documentId === documentId ? observed : null, load = current?.load;
  if (load?.state === "ready") return null;
  return <div className={`project-load-status${load?.state === "failed" ? " failed" : ""}`} role="status" aria-label="工程载入状态" data-document-id={documentId}>
    <div><strong>{load ? documentLoadLabel(load) : "正在打开工程"}</strong><small>{documentId}</small></div>
    <p>{current?.error || load?.error || (load?.state === "failed" ? "未用空工程替代原数据，请从有效备份恢复。" : "只载入当前工程；原始检查点保留，不会重复执行建模命令。")}</p>
    {load?.state === "loading" && load.elapsedMs != null && <span aria-live="off">已等待 {Math.floor(load.elapsedMs / 1000)} 秒 · 阶段耗时不代表完成百分比</span>}
  </div>;
}
