"use client";

import { useId, useLayoutEffect, useRef } from "react";
import type { ScalarVariableData } from "../ProjectDataPanel";

export function MissingVariableEditor({ name, type, expression, busy, canSubmit = true, message, onType, onExpression, onCancel, onSubmit }: {
  name: string;
  type: ScalarVariableData["type"];
  expression: string;
  busy: boolean;
  canSubmit?: boolean;
  message: string | null;
  onType: (type: ScalarVariableData["type"]) => void;
  onExpression: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLFormElement>(null);
  const hintId = useId();
  useLayoutEffect(() => {
    const form = ref.current;
    const trigger = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (form?.contains(document.activeElement) && trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);
  return <form ref={ref} className="inline-dialog" role="dialog" aria-label="创建缺失变量"
    onSubmit={event => { event.preventDefault(); if (!busy && canSubmit && expression.trim()) onSubmit(); }}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || (event.target instanceof HTMLSelectElement)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !busy) onCancel();
    }}>
    <h3>未定义变量：{name}</h3>
    <p id={hintId}>{busy ? "变量和几何正在同一任务中处理。可在下方任务状态区取消。" : "创建变量后将自动重试原操作。请核对变量类型和初始值。"}</p>
    <label><span>类型</span><select disabled={busy} value={type} onChange={event => onType(event.target.value as ScalarVariableData["type"])}>
      <option value="length">长度</option><option value="angle">角度</option><option value="dimensionless">无量纲</option><option value="integer">整数</option>
    </select></label>
    <label><span>表达式</span><input ref={inputRef} disabled={busy} value={expression} onChange={event => onExpression(event.target.value)} aria-describedby={hintId} /></label>
    {message && <p className="property-error" role="alert">{message}</p>}
    <div className="dialog-actions">
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" className="primary-action" disabled={busy || !canSubmit || !expression.trim()}>{busy ? "处理中…" : "创建并重试"}</button>
    </div>
  </form>;
}
