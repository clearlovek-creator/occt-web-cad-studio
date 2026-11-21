"use client";

import { useEffect, useRef, useState } from "react";
import { engineeringNumber, fullPrecisionNumber } from "./modeling/engineering-number";
import { compactMeasurement, measurementMatches, measurementRows, measurementState, measurementTargetKey, type MeasurementResult, type MeasurementSnapshot, type MeasurementTarget } from "./modeling/measurement";
import { modelingController } from "./modeling/runtime";
import { useModelingController } from "./modeling/modeling-controller";
import type { ModelingCommandResponse } from "./modeling/command-contract";

const curveNames: Record<string, string> = { line: "直线", circle: "圆 / 圆弧", ellipse: "椭圆", hyperbola: "双曲线", parabola: "抛物线", bezier: "Bezier 曲线", bspline: "B 样条", other: "其他曲线" };

export function MeasurementPanel({ target, disabled, onResult }: { target: MeasurementTarget | null; disabled: boolean; onResult?: (snapshot: MeasurementSnapshot) => void }) {
  const state = useModelingController(modelingController);
  const [snapshot, setSnapshot] = useState<MeasurementSnapshot | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const epoch = useRef(0), currentTarget = useRef("");
  const targetKey = measurementTargetKey(target);
  useEffect(() => { currentTarget.current = targetKey; }, [targetKey]);
  useEffect(() => () => { epoch.current++; }, []);
  const status = snapshot ? measurementState(snapshot, target, state.stateToken) : null;
  const raw = snapshot ? JSON.stringify({ format: "web-cad-measurement", version: 1, coordinateSystem: "global", units: { length: "mm", area: "mm²", volume: "mm³" }, target: snapshot.target, result: snapshot.result }, null, 2) : "";
  const run = async () => {
    if (!target || disabled || pending || !state.stateToken) return;
    const owner = { ...target }, token = state.stateToken, request = ++epoch.current;
    setPending(true); setError(null); setCopied(false);
    try {
      const result = await modelingController.execute<ModelingCommandResponse & MeasurementResult>({ operation: "geometry.measure", inputs: { bodyId: owner.bodyId, selectionType: owner.selectionType, selectionId: owner.selectionId } });
      if (epoch.current !== request) return;
      const now = modelingController.getSnapshot();
      if (now.documentId !== owner.documentId || now.stateToken !== token || currentTarget.current !== measurementTargetKey(owner) || !measurementMatches(result, owner, token)) {
        setError("测量期间工程状态或选择已变化，本次结果未采用；请测量当前对象。"); return;
      }
      const next = { target: owner, stateToken: token, result: compactMeasurement(result) };
      setSnapshot(next);
      onResult?.(next);
    } catch (reason) { if (epoch.current === request) setError(reason instanceof Error ? reason.message : "几何测量失败，请重试。"); }
    finally { if (epoch.current === request) setPending(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(raw); setCopied(true); }
    catch { setError("无法访问剪贴板，可展开原始数据后手动选择复制。"); }
  };
  return <section className="panel-section measurement-panel" data-testid="measurement-panel">
    <div className="section-heading compact"><div><span className="eyebrow">BREP MEASUREMENT</span><h2>几何测量</h2></div><span className="feature-badge">只读</span></div>
    <p className="panel-copy">测量当前 Body，或先选择体、面、边。坐标采用 Global，长度单位为毫米。</p>
    <div className="measurement-target"><span>测量对象</span><strong>{target ? `${target.selectionType === "body" ? "体" : target.selectionType === "face" ? "面" : "边"} · ${target.selectionId}` : "未选择可测量对象"}</strong>{target && <small>{target.bodyId}</small>}</div>
    <button type="button" className="secondary-action" onClick={() => void run()} disabled={disabled || pending || !target || !state.stateToken} data-testid="run-measure">{pending ? "正在测量…" : "测量当前对象"}</button>
    {error && <p className="property-error" role="alert">{error}</p>}
    {snapshot && <div className="measurement-result" data-state={status}>
      <div className="measurement-result-heading"><strong>测量结果</strong><span>{status === "current" ? "当前" : status === "different-target" ? "上次选择" : "已过期"} · R{snapshot.result.revision ?? "—"}</span></div>
      <p className="measurement-source">{snapshot.target.bodyId} / {snapshot.target.selectionId}</p>
      {status !== "current" && <p className="measurement-warning" role="status">{status === "different-target" ? "下列结果属于上次选择，不是当前对象。" : "工程状态已变化，下列历史结果不能代表当前几何。"} 请重新测量。</p>}
      <dl className="measurement-values">{measurementRows(snapshot.result).map(row => <div key={row.key} data-metric={row.key}>
        <dt>{row.label}{row.unit && <small>{row.unit}</small>}</dt>
        <dd>{row.vector ? <span className="measurement-vector">{["X", "Y", "Z"].map((axis, index) => {
          const value = Array.isArray(row.value) ? row.value[index] : undefined;
          return <span key={axis}><small>{axis}</small><span title={fullPrecisionNumber(value)}>{engineeringNumber(value)}</span></span>;
        })}</span> : row.text ? curveNames[String(row.value)] || (typeof row.value === "string" ? row.value : "—") : <span title={fullPrecisionNumber(row.value)}>{engineeringNumber(row.value)}</span>}</dd>
      </div>)}</dl>
      {snapshot.result.selectionType === "body" && <p className="measurement-note">{snapshot.result.edgeLengthPolicy === "unique-topological-edges" ? "拓扑边总长：共享边只计一次，包含曲面的拓扑接缝；不是模型的外轮廓周长。" : "旧内核的边长累计可能重复计算共享边；请勿按独立边总长使用。"}</p>}
      {snapshot.result.selectionType === "face" && <p className="measurement-note">周长按该面的参数边界计量，可能包含拓扑接缝的两侧；不是整张曲面的可见外轮廓长度。</p>}
      <p className="measurement-note">显示 8 位有效数字；极小或极大值使用工程计数法。显示位数不代表内核精度或几何容差，未缩减计算数据。</p>
      <details className="measurement-raw"><summary>完整原始数据（未按显示位数舍入）</summary><pre tabIndex={0} aria-label="测量原始数据">{raw}</pre></details>
      <button type="button" className="secondary-action" onClick={() => void copy()}>{copied ? "已复制测量数据" : "复制测量数据"}</button>
    </div>}
  </section>;
}
