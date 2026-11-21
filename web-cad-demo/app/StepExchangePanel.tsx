"use client";

import { useRef, useState } from "react";
import type { FeatureData } from "./ModelMetadataPanels";

export type StepImportModel = {
  ok: true;
  revision: number;
  bodyCount: number;
  bodyId: string;
  topologyRevision: number;
  features: FeatureData[];
  positions: number[];
  normals: number[];
  indices: number[];
  triangleFaceIds: string[];
  edges: { edgeId: string; points: number[] }[];
  stats: { faceCount: number; edgeCount: number; triangleCount: number };
};

export function StepExchangePanel({
  hasModel,
  onImported,
  onImport,
  onExport,
  onProjectSave,
  onProjectOpen,
  projectSaveBusy,
}: {
  hasModel: boolean;
  onImported: (model: StepImportModel) => void;
  onImport: (file: File) => Promise<StepImportModel>;
  onExport: () => Promise<string>;
  onProjectSave: () => Promise<void>;
  onProjectOpen: (file: File) => Promise<unknown>;
  projectSaveBusy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const importFile = async (file: File) => {
    setBusy(true);
    setMessage("正在导入 STEP…");
    try {
      const result = await onImport(file);
      onImported(result);
      setMessage(`已导入 ${file.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "STEP 导入失败。");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const openProject = async (file: File) => {
    setBusy(true); setMessage("正在打开工程…");
    try { const result = await onProjectOpen(file); onImported(result as StepImportModel); setMessage(`已打开 ${file.name}`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "工程打开失败。"); }
    finally { setBusy(false); if (projectInputRef.current) projectInputRef.current.value = ""; }
  };

  const exportFile = async () => {
    setBusy(true);
    setMessage("正在导出 STEP…");
    try {
      const downloadUrl = await onExport();
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = "default.step";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setMessage("STEP 文件已生成。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "STEP 导出失败。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-section step-exchange" data-testid="step-exchange">
      <div className="section-heading compact">
        <div><span className="eyebrow">PROJECT FILES</span><h2>工程 / STEP</h2></div>
        <span className="feature-badge">AP242</span>
      </div>
      <p className="panel-copy">工程包包含精确几何、变量、材料、坐标系、属性类型和实例，以及 STEP 重算来源。旧 XBF 仅作为兼容格式打开。网格结果与 Agent 会话不包含在本版工程包中。</p>
      <input
        ref={projectInputRef}
        type="file"
        accept=".cadproj,.xbf,application/vnd.webcad.project,application/x-occt-xbf"
        hidden
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void openProject(file); }}
      />
      <input
        ref={inputRef}
        type="file"
        accept=".step,.stp,application/step"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
        }}
      />
      <div className="exchange-actions">
        <button disabled={busy} onClick={() => projectInputRef.current?.click()}>打开工程</button>
        <button disabled={busy || projectSaveBusy || !hasModel} onClick={() => void onProjectSave()}>保存工程</button>
        <button disabled={busy} onClick={() => inputRef.current?.click()}>导入 STEP</button>
        <button disabled={busy || !hasModel} onClick={() => void exportFile()}>导出 STEP</button>
      </div>
      {message && <p className="exchange-message">{message}</p>}
    </section>
  );
}
