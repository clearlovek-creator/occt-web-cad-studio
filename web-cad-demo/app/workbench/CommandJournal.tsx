"use client";
import { useEffect, useRef, useState } from "react";
import { API_ROOT } from "../api-config";
import type { CommandLogEntry } from "../modeling/modeling-controller";

export type JournalIdentity = Pick<CommandLogEntry, 'operation' | 'requestId'>;
const entryKey = (entry: JournalIdentity) => JSON.stringify([entry.operation, entry.requestId]);
const unsettled = (entry: CommandLogEntry) => entry.status === 'running' || entry.status === 'unknown';

async function requestJournal(documentId: string, options: {method?: 'DELETE'; requestId?: string; signal?: AbortSignal} = {}) {
    const query = options.requestId ? '?requestId=' + encodeURIComponent(options.requestId) : '';
    const timeout = AbortSignal.timeout(10000);
    const response = await fetch(`${API_ROOT}/documents/${encodeURIComponent(documentId)}/command-journal${query}`, {
        method: options.method ?? 'GET', cache: 'no-store',
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true || payload.documentId !== documentId || !Array.isArray(payload.entries))
        throw new Error('工程命令日志暂不可用。');
    return {entries: payload.entries as CommandLogEntry[], removed: (payload.removed ?? []) as JournalIdentity[]};
}

export function CommandJournal({ documentId, active, entries, onClear, onClearTasks }: {
    documentId: string;
    active: boolean;
    entries: CommandLogEntry[];
    onClear: (confirmed: JournalIdentity[]) => void;
    onClearTasks?: () => Promise<{
        deleted?: number;
        retained?: number;
    }>;
}) {
    const [failuresOnly, setFailuresOnly] = useState(false);
    const [query, setQuery] = useState("");
    const [copyState, setCopyState] = useState("");
    const [clearing, setClearing] = useState(false), [cleanupNotice, setCleanupNotice] = useState('');
    const [saved, setSaved] = useState<CommandLogEntry[]>([]);
    const [syncError, setSyncError] = useState('');
    const [journalNotice, setJournalNotice] = useState('');
    const [action, setAction] = useState<'check' | 'clear' | null>(null);
    const actionRef = useRef(false);
    const syncVersion = useRef(0);
    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            const version = syncVersion.current;
            try {
                if (!actionRef.current) {
                    const {entries: rows} = await requestJournal(documentId, {signal:controller.signal});
                    if (!controller.signal.aborted && version === syncVersion.current) {
                        setSaved(rows);
                        setSyncError('');
                    }
                }
            } catch {
                if (!controller.signal.aborted && version === syncVersion.current) setSyncError('暂时无法同步工程日志。');
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
            }
        };
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [active, documentId]);

    const merged = new Map(entries.map(entry => [entryKey(entry), entry]));
    for (const record of saved) {
        const key = entryKey(record), local = merged.get(key);
        if (local && record.status === 'running' && local.status !== 'running') {
            merged.set(key, {...local, taskId: record.taskId ?? local.taskId});
        } else {
            merged.set(key, {...local, ...record, code: record.status === local?.status ? (record.code ?? local.code) : record.code,
                message: record.status === local?.status ? local.message : undefined});
        }
    }
    const filter = query.toLowerCase().trim();
    const visible = [...merged.values()].filter(entry => {
        if (failuresOnly && entry.status !== 'error') return false;
        return !filter || [entry.operation, entry.requestId, entry.taskId, entry.code, entry.message]
            .some(value => value?.toLowerCase().includes(filter));
    }).sort((a, b) => b.startedAt - a.startedAt);

    const updateJournal = async (entry?: CommandLogEntry) => {
        if (actionRef.current) return;
        actionRef.current = true;
        syncVersion.current++;
        setAction(entry ? 'check' : 'clear');
        setJournalNotice('');
        try {
            if (entry) {
                const {entries: records} = await requestJournal(documentId, {requestId:entry.requestId});
                const result = records.find(record => entryKey(record) === entryKey(entry));
                if (result) setSaved(current => [...current.filter(item => entryKey(item) !== entryKey(entry)), result]);
                setJournalNotice(!result ? '未找到原请求的后台记录，结果仍待核对。'
                    : result.status === 'unknown' ? '尚未找到可确认原请求结果的记录。'
                    : result.status === 'running' ? '原请求仍在执行。' : '已核对原请求。');
            } else {
                const {entries: records, removed} = await requestJournal(documentId, {method:'DELETE'});
                setSaved(records);
                onClear(removed);
            }
            setSyncError('');
        } catch {
            setJournalNotice(entry ? '暂时无法核对原请求。' : '暂时无法清除已完成记录。');
        } finally {
            actionRef.current = false;
            setAction(null);
        }
    };
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
    <div className="command-journal-toolbar"><input type="search" aria-label="搜索命令日志" placeholder="命令、请求 ID 或错误码" value={query} onChange={event => { setQuery(event.target.value); setCopyState(""); }} /><label><input type="checkbox" checked={failuresOnly} onChange={(event) => { setFailuresOnly(event.target.checked); setCopyState(""); }}/>仅失败</label><span>{visible.length} 条记录</span><button type="button" disabled={!visible.length} onClick={() => void copy()}>{copyState || "复制诊断"}</button><button type="button" disabled={action !== null} title="清除当前工程已完成、失败或取消的命令记录。" onClick={() => void updateJournal()}>清除已完成</button>{onClearTasks && <button type="button" disabled={clearing} title="清除当前工程已结束的后台任务记录。" onClick={() => { setClearing(true); void onClearTasks().then(result => setCleanupNotice(`已清理 ${result.deleted ?? 0} 项记录${result.retained ? `，${result.retained} 项需检查` : ''}`)).catch(reason => setCleanupNotice(reason instanceof Error ? reason.message : '任务记录清理未完成。')).finally(() => setClearing(false)); }}>{clearing ? '清理中' : '清理后台已完成任务'}</button>}{cleanupNotice && <span role="status">{cleanupNotice}</span>}{(journalNotice || syncError) && <span role="status">{journalNotice || syncError}</span>}</div>
    <div className="command-journal-list">{!visible.length ? <p>{filter ? "没有匹配的命令记录" : `暂无${failuresOnly ? "失败" : "命令"}记录`}</p> : visible.map((entry) => <details key={entryKey(entry)} className={`command-journal-entry ${entry.status}`}>
      <summary><time dateTime={new Date(entry.startedAt).toISOString()} title={new Date(entry.startedAt).toLocaleString("zh-CN")}>{new Date(entry.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}</time><strong>{entry.operation}</strong><span>{entry.status === "running" ? "执行中" : entry.status === "unknown" ? "待核对" : entry.status === "cancelled" ? '已取消' : entry.status === "error" ? entry.code === 'MODELING_TASK_RECEIPT_UNAVAILABLE' ? '已提交 · 待同步' : "失败" : entry.warningCount ? `完成 · ${entry.warningCount} 条警告` : "完成"}</span><span>{entry.durationMs === undefined ? "—" : `${entry.durationMs} ms`}</span>{entry.revision !== undefined && <span>R{entry.revision}</span>}</summary>
      <dl><dt>请求 ID</dt><dd>{entry.requestId}</dd><dt>工程 ID</dt><dd>{entry.documentId}</dd>{entry.taskId && <><dt>任务 ID</dt><dd>{entry.taskId}</dd></>}{entry.code && <><dt>错误码</dt><dd>{entry.code}</dd></>}{entry.message && <><dt>详情</dt><dd>{entry.message}</dd></>}{entry.warnings?.length ? <><dt>警告</dt><dd>{entry.warnings.join("\n")}</dd></> : null}</dl>
      {unsettled(entry) && <button type="button" disabled={action !== null} onClick={() => void updateJournal(entry)}>核对结果</button>}
    </details>)}</div>
  </section>;
}
