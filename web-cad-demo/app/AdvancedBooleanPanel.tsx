"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DirectModelResult } from "./DirectModelingPanel";

type BooleanOperation = "fuse" | "cut" | "common" | "section" | "split" | "partition" | "fragments" | "imprint";
type BodySummary = { id: string; sourceFeatureId: string; topologyRevision: number; name?: string };
type Summary = { ok: true; revision: number; bodies: BodySummary[]; bodyMetadata?: { bodyId: string; name: string }[]; error?: string };
import {useEditorCommands} from "./modeling/CommandEditScope";


export function AdvancedBooleanPanel({ model, onModel, initialOperation = "cut" }: { model: { revision: number } | null; onModel: (result: DirectModelResult) => void; initialOperation?: BooleanOperation }) {
  const {execute:command}=useEditorCommands();
  const [bodies, setBodies] = useState<BodySummary[]>([]);
  const [operation, setOperation] = useState<BooleanOperation>(initialOperation);
  const [targets, setTargets] = useState<string[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [keepTarget, setKeepTarget] = useState(false);
  const [keepTool, setKeepTool] = useState(false);
  const [refine, setRefine] = useState(true);
  const [splitResults, setSplitResults] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const initializedRoles = useRef(false);
  const imprint = operation === "imprint";

  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    void command<Summary>({ operation: "document.summary" }).then((summary) => {
      if (cancelled) return;
      const names = new Map((summary.bodyMetadata || []).map((item) => [item.bodyId, item.name]));
      const list = summary.bodies.map((body) => ({ ...body, name: names.get(body.id) || body.id }));
      setBodies(list);
      if (!initializedRoles.current && list.length > 0) {
        initializedRoles.current = true;
        setTargets(list[0] ? [list[0].id] : []);
        setTools(list[1] ? [list[1].id] : []);
      }
    }).catch((reason) => { if (!cancelled) setMessage(reason instanceof Error ? reason.message : "无法读取 Body 列表。"); });
    return () => { cancelled = true; };
  }, [model]);

  const toggle = (id: string, group: "target" | "tool") => {
    if (group === "target") {
      setTargets((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
      setTools((current) => current.filter((item) => item !== id));
    } else {
      setTools((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
      setTargets((current) => current.filter((item) => item !== id));
    }
  };
  const missing=[...targets,...tools].filter(id=>!bodies.some(body=>body.id===id));
  const ready = useMemo(() => Boolean(model && targets.length && tools.length && [...targets,...tools].every(id=>bodies.some(body=>body.id===id))), [model, targets, tools,bodies]);
  const execute = async () => {
    if (!model || !ready) return;
    setBusy(true); setMessage(null);
    try {
      const result = await command<DirectModelResult & { error?: string }>({ operation: `boolean.${operation}`, baseRevision: model.revision, inputs: { targetBodies: targets, toolBodies: tools }, parameters: { keepTarget, keepTool: imprint || keepTool, refine, splitResults } });
      setTargets(result.bodyId?[result.bodyId]:[]);setTools([]);onModel(result); setMessage(`Boolean ${operation} 完成，文档版本 R${result.revision}`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Boolean 操作失败。"); }
    finally { setBusy(false); }
  };

  return <section className="panel-section boolean-panel advanced-boolean" data-testid="advanced-boolean-panel">
    <div className="section-heading compact"><div><span className="eyebrow">OCCT BOOLEAN</span><h2>多 Body 布尔与分割</h2></div><span className="feature-badge amber">{bodies.length} Bodies</span></div>
    <select className="operation-select" aria-label="Boolean 操作" value={operation} onChange={(event) => setOperation(event.target.value as BooleanOperation)}>
      <option value="fuse">Fuse 并集</option><option value="cut">Cut 差集</option><option value="common">Common 交集</option><option value="section">Section 截交线</option><option value="split">Split 分割</option><option value="partition">Partition 分区</option><option value="fragments">Fragments 全碎片</option><option value="imprint">Imprint 压印</option>
    </select>
    <p className="boolean-role-hint">{operation === "cut" ? "从目标中减去工具；勾选另一列可直接切换对象角色。" : "选择参与运算的目标和工具；勾选另一列可直接切换对象角色。"}</p>
    {missing.length>0 && <p className="property-error" role="alert">输入对象已不存在：{missing.join(", ")}。原角色选择已保留，请重新载入并选择输入，不会自动换成其他 Body。</p>}
    <div className="body-role-grid"><div><strong>目标 Target（可多选）</strong>{bodies.map((body) => <label className="body-role" key={`target-${body.id}`}><input type="checkbox" checked={targets.includes(body.id)} onChange={() => toggle(body.id, "target")} /><span>{body.name}<small>{body.id} · {body.sourceFeatureId}</small></span></label>)}</div><div><strong>工具 Tool（可多选）</strong>{bodies.map((body) => <label className="body-role" key={`tool-${body.id}`}><input type="checkbox" checked={tools.includes(body.id)} onChange={() => toggle(body.id, "tool")} /><span>{body.name}<small>{body.id} · {body.sourceFeatureId}</small></span></label>)}</div></div>
    <div className="boolean-options"><label className="check-field"><input type="checkbox" checked={keepTarget} onChange={(event) => setKeepTarget(event.target.checked)} /><span>保留 Target</span></label><label className="check-field"><input type="checkbox" checked={imprint || keepTool} disabled={imprint} onChange={(event) => setKeepTool(event.target.checked)} /><span>保留 Tool{imprint && "（压印固定保留）"}</span></label><label className="check-field"><input type="checkbox" checked={refine} onChange={(event) => setRefine(event.target.checked)} /><span>Refine 同域合并</span></label><label className="check-field"><input type="checkbox" checked={splitResults} onChange={(event) => setSplitResults(event.target.checked)} /><span>结果拆分为多个 Body</span></label></div>
    <button className="secondary-action" disabled={busy || !ready} onClick={() => void execute()}>执行 Boolean {operation}</button>
    {bodies.length < 2 ? <p className="panel-copy">至少创建两个 Body 后才能执行布尔或分割。</p> : !ready && <p className="panel-copy">请至少选择一个目标和一个工具。</p>}
    {message && <p className="exchange-message" role="status">{message}</p>}
  </section>;
}
