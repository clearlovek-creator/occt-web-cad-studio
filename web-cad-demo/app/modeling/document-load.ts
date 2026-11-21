export type DocumentLoadState = { state: "unloaded" | "loading" | "ready" | "failed"; phase: string; error?: string | null; elapsedMs?: number; durationMs?: number; recovered?: boolean; interrupted?: boolean };
const phaseNames: Record<string, string> = { waiting: "等待按需载入", checking: "校验检查点", "restoring-geometry": "恢复 BRep 几何", "restoring-project-data": "同步属性与工程数据", finalizing: "完成恢复", ready: "已载入", failed: "载入失败" };
export function documentLoadLabel(value: DocumentLoadState): string { return phaseNames[value.phase] || (value.state === "loading" ? "正在载入工程" : value.state === "failed" ? "载入失败" : value.state === "ready" ? "已载入" : "尚未载入"); }
export function parseDocumentLoad(value: unknown): DocumentLoadState | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!["unloaded", "loading", "ready", "failed"].includes(String(item.state)) || typeof item.phase !== "string") return null;
  return { state: item.state as DocumentLoadState["state"], phase: item.phase, error: typeof item.error === "string" ? item.error.slice(0, 1000) : null, elapsedMs: typeof item.elapsedMs === "number" && Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0 ? item.elapsedMs : undefined, recovered: item.recovered === true, interrupted: item.interrupted === true };
}
