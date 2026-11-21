"use client";

import { useState, type ReactNode } from "react";
import type { BodyTreeData } from "../ModelMetadataPanels";
import { engineeringNumber } from "../modeling/engineering-number";
import { StudioIcon } from "./StudioIcon";

export const studioPanels = {
  tree: "工程管理",
  properties: "属性 / 几何信息",
  commands: "命令 / 参数",
  console: "消息 / 日志",
};
export type StudioPanel = keyof typeof studioPanels;
export type StudioPanelVisibility = Record<StudioPanel, boolean>;
export const defaultStudioPanels: StudioPanelVisibility = { tree: true, properties: true, commands: true, console: true };

export function PaneHeader({ title, closeLabel, onClose }: { title: string; closeLabel: string; onClose: () => void }) {
  return <div className="studio-pane-header"><strong>{title}</strong><button type="button" title={closeLabel} aria-label={closeLabel} onClick={onClose}><StudioIcon name="close" /></button></div>;
}

export function PaneTabs<T extends string>({ tabs, active, onChange, label }: { tabs: readonly T[]; active: T; onChange: (value: T) => void; label: string }) {
  return <div className="studio-pane-tabs" role="group" aria-label={label}>{tabs.map(tab => <button type="button" key={tab} aria-pressed={active === tab} onClick={() => onChange(tab)}>{tab}</button>)}</div>;
}

export function PropertyTable({ sections }: { sections: { title: string; rows: [string, ReactNode][] }[] }) {
  return <>{sections.map(({ title, rows }) => <section className="studio-property-section" key={title}><h3>{title}</h3><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>)}</>;
}

export type SelectionDetails = {
  body?: BodyTreeData;
  selectionId: string | null;
  dimensions: number[] | null;
  stats?: { faceCount: number; edgeCount: number; triangleCount: number };
};

export function SelectionTable({ details, tab }: { details: SelectionDetails; tab: "属性" | "几何信息" | "拓扑" }) {
  const { body, selectionId, dimensions, stats } = details;
  if (!body) return <p className="studio-empty">在工程树或视口选择一个几何体。</p>;
  const kind = body.kind === "sheet" ? "面体" : body.kind === "wire" ? "线体" : body.kind === "shape" ? "几何体" : "实体";
  const dimensionsSection = dimensions ? [{ title: "尺寸 (mm)", rows: ["长度 (X)", "宽度 (Y)", "高度 (Z)"].map((label, index): [string, string] => [label, engineeringNumber(dimensions[index])]) }] : [];
  if (tab === "拓扑") return <PropertyTable sections={[{ title: "拓扑统计", rows: [["面", stats?.faceCount ?? "—"], ["边", stats?.edgeCount ?? "—"], ["三角形", stats?.triangleCount ?? "—"], ["拓扑版本", body.topologyRevision]] }]} />;
  if (tab === "几何信息") return <PropertyTable sections={[{ title: "几何对象", rows: [["几何体 ID", body.bodyId], ["选中对象", selectionId ?? body.bodyId], ["类型", kind], ["单位", "mm"]] }, ...dimensionsSection]} />;
  return <PropertyTable sections={[{ title: "基本属性", rows: [["名称", body.name || body.bodyId], ["类型", kind], ["颜色", body.color ? <><i className="studio-swatch" style={{ background: body.color }} />{body.color.toUpperCase()}</> : "—"], ["透明度", `${Number(((1 - (body.opacity ?? 1)) * 100).toFixed(1))}%`], ["材料", body.material || "—"], ["可见性", body.visible === false ? "隐藏" : "显示"]] }, ...dimensionsSection]} />;
}

export function PropertiesDock({ details, hidden, onClose }: { details: SelectionDetails; hidden: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"属性" | "几何信息" | "拓扑">("属性");
  return <section className="studio-pane studio-properties" aria-label="属性" hidden={hidden}>
    <PaneHeader title="属性" closeLabel="隐藏属性面板" onClose={onClose} />
    <PaneTabs tabs={["属性", "几何信息", "拓扑"]} active={tab} onChange={setTab} label="属性视图" />
    <div className="studio-pane-scroll"><SelectionTable details={details} tab={tab} /></div>
  </section>;
}

export function CommandDock({ children, details, help, hidden, onClose, version }: { children: ReactNode; details: SelectionDetails; help: ReactNode; hidden: boolean; onClose: () => void; version: number }) {
  type CommandTab = "参数" | "对象信息" | "帮助";
  const [selection, setSelection] = useState<{ tab: CommandTab; version: number }>({ tab: "参数", version });
  const tab: CommandTab = selection.version === version ? selection.tab : "参数";
  return <section className="studio-pane studio-commands" aria-label="命令参数" hidden={hidden}>
    <PaneHeader title="命令 / 参数" closeLabel="隐藏命令面板" onClose={onClose} />
    <PaneTabs tabs={["参数", "对象信息", "帮助"]} active={tab} onChange={next => setSelection({ tab: next, version })} label="命令视图" />
    <div className="studio-pane-scroll" hidden={tab !== "参数"}>{children}</div>
    {tab === "对象信息" && <div className="studio-pane-scroll"><SelectionTable details={details} tab="几何信息" /></div>}
    {tab === "帮助" && <div className="studio-pane-scroll studio-empty">{help}</div>}
  </section>;
}
