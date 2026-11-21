"use client";
import { useState } from "react";
import type { CommandLogEntry } from "../modeling/modeling-controller";
export function CommandJournal({ entries, onClear, onClearTasks }: {
    entries: CommandLogEntry[];
    onClear: () => void;
    onClearTasks?: () => Promise<{
        deleted?: number;
        retained?: number;
    }>;
}) {
    const [failuresOnly, setFailuresOnly] = useState(false);
    const [copyState, setCopyState] = useState("");
    const [clearing, setClearing] = useState(false), [cleanupNotice, setCleanupNotice] = useState('');
    const visible = entries.filter((entry) => !failuresOnly || entry.status === "error").toReversed();
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify({ format: "web-cad-command-diagnostics", version: 1, entries: visible }, null, 2));
            setCopyState("已复制");
        }
        catch {
            setCopyState("复制失败，请展开记录手动复制");
        }
    };
    return <section className="command-journal" aria-label="命令执行日志" data-testid="command-journal">
    <div className="command-journal-toolbar"><label><input type="checkbox" checked={failuresOnly} onChange={(event) => setFailuresOnly(event.target.checked)}/>仅失败</label><span>当前工程 · 本页会话 · 不记录参数</span><button type="button" onClick={() => void copy()}>{copyState || "复制诊断"}</button><button type="button" title="只清除当前工程本页已结束的命令记录。" onClick={onClear}>清除已完成</button>{onClearTasks && <button type="button" disabled={clearing} title="只删除当前工程已完成、已失败或已取消的任务记录，不删除几何，不清理未确认结果。" onClick={() => { setClearing(true); void onClearTasks().then(result => setCleanupNotice(`已清理 ${result.deleted ?? 0} 项记录${result.retained ? `，${result.retained} 项需检查` : ''}`)).catch(reason => setCleanupNotice(reason instanceof Error ? reason.message : '任务记录清理未完成。')).finally(() => setClearing(false)); }}>{clearing ? '清理中' : '清理后台已完成任务'}</button>}{cleanupNotice && <span role="status">{cleanupNotice}</span>}</div>
    <div className="command-journal-list">{!visible.length ? <p>暂无{failuresOnly ? "失败" : "命令"}记录</p> : visible.map((entry) => <details key={entry.requestId} className={`command-journal-entry ${entry.status}`}>
      <summary><time>{new Date(entry.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}</time><strong>{entry.operation}</strong><span>{entry.status === "running" ? "执行中" : entry.status === "cancelled" ? '已取消' : entry.status === "error" ? entry.code === 'MODELING_TASK_RECEIPT_UNAVAILABLE' ? '已提交 · 待同步' : "失败" : entry.warningCount ? `完成 · ${entry.warningCount} 条警告` : "完成"}</span><span>{entry.durationMs === undefined ? "—" : `${entry.durationMs} ms`}</span>{entry.revision !== undefined && <span>R{entry.revision}</span>}</summary>
      <dl><dt>请求 ID</dt><dd>{entry.requestId}</dd><dt>工程 ID</dt><dd>{entry.documentId}</dd>{entry.code && <><dt>错误码</dt><dd>{entry.code}</dd></>}{entry.message && <><dt>详情</dt><dd>{entry.message}</dd></>}{entry.warnings?.length ? <><dt>警告</dt><dd>{entry.warnings.join("\n")}</dd></> : null}</dl>
    </details>)}</div>
  </section>;
}
