"use client";

import { useEffect, useState } from "react";
import type { DirectModelResult } from "./DirectModelingPanel";

type BooleanOperation = "fuse" | "cut" | "common";
type BodySummary = { id: string; sourceFeatureId: string; topologyRevision: number };
type SummaryResult = {
  ok: true;
  revision: number;
  bodies: BodySummary[];
};

import type { ModelingCommandInput } from "./modeling/command-contract";
import { executeModelingCommand } from "./modeling/runtime";

async function command<T extends { ok: boolean }>(payload: ModelingCommandInput) {
  return await executeModelingCommand(payload) as T;
}

export function BooleanPanel({
  model,
  onModel,
}: {
  model: { revision: number } | null;
  onModel: (result: DirectModelResult) => void;
}) {
  const [bodies, setBodies] = useState<BodySummary[]>([]);
  const [operation, setOperation] = useState<BooleanOperation>("cut");
  const [targetBody, setTargetBody] = useState("");
  const [toolBody, setToolBody] = useState("");
  const [keepTool, setKeepTool] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    void command<SummaryResult>({ operation: "document.summary" })
      .then((summary) => {
        if (cancelled) return;
        setBodies(summary.bodies);
        setTargetBody((current) => summary.bodies.some((body) => body.id === current)
          ? current : summary.bodies[0]?.id || "");
        setToolBody((current) => summary.bodies.some((body) => body.id === current)
          ? current : summary.bodies[1]?.id || "");
      })
      .catch((reason) => {
        if (!cancelled) setMessage(reason instanceof Error ? reason.message : "无法读取 Body 列表。");
      });
    return () => { cancelled = true; };
  }, [model]);

  const execute = async () => {
    if (!model || !targetBody || !toolBody || targetBody === toolBody) return;
    setBusy(true); setMessage(null);
    try {
      const result = await command<DirectModelResult>({
        operation: `boolean.${operation}`,
        baseRevision: model.revision,
        inputs: { targetBody, toolBody },
        parameters: { keepTool },
      });
      onModel(result);
      setMessage(`Boolean ${operation} 完成，文档版本 R${result.revision}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Boolean 操作失败。");
    } finally { setBusy(false); }
  };

  const ready = Boolean(model && bodies.length >= 2 && targetBody && toolBody && targetBody !== toolBody);

  return (
    <section className="panel-section boolean-panel" data-testid="boolean-panel">
      <div className="section-heading compact">
        <div><span className="eyebrow">MULTI BODY</span><h2>Boolean 布尔运算</h2></div>
        <span className="feature-badge amber">{bodies.length} Bodies</span>
      </div>
      <select className="operation-select" aria-label="Boolean 操作" value={operation} onChange={(event) => setOperation(event.target.value as BooleanOperation)}>
        <option value="cut">Cut 差集</option>
        <option value="fuse">Fuse 并集</option>
        <option value="common">Common 交集</option>
      </select>
      <div className="boolean-fields">
        <label><span>Target</span><select aria-label="Target Body" value={targetBody} onChange={(event) => setTargetBody(event.target.value)}>{bodies.map((body) => <option key={body.id} value={body.id}>{body.id} · {body.sourceFeatureId}</option>)}</select></label>
        <label><span>Tool</span><select aria-label="Tool Body" value={toolBody} onChange={(event) => setToolBody(event.target.value)}>{bodies.map((body) => <option key={body.id} value={body.id}>{body.id} · {body.sourceFeatureId}</option>)}</select></label>
      </div>
      <label className="check-field"><input type="checkbox" checked={keepTool} onChange={(event) => setKeepTool(event.target.checked)} /><span>运算后保留 Tool Body</span></label>
      <button className="secondary-action" disabled={busy || !ready} onClick={() => void execute()}>执行 Boolean {operation}</button>
      {bodies.length < 2 && <p className="panel-copy boolean-hint">至少创建两个 Body 后才能执行布尔运算。</p>}
      {message && <p className="exchange-message">{message}</p>}
    </section>
  );
}
