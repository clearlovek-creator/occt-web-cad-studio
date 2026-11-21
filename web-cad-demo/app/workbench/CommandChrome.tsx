"use client";

import { useState } from "react";
import { WORKBENCH_TABS, type WorkbenchCommand } from "./ribbon-catalog";
import { PrimitiveToolIcon } from "./PrimitiveToolIcon";
import { StudioIcon } from "./StudioIcon";

export function CommandChrome({ availability, onCommand }: { availability: (id: WorkbenchCommand) => { enabled: boolean; reason?: string; active?: boolean }; onCommand: (id: WorkbenchCommand) => void }) {
  const [activeTab, setActiveTab] = useState("建模");
  const tab = WORKBENCH_TABS.find((item) => item.label === activeTab)!;
  return <section className="workbench-ribbon" aria-label="建模功能区">
    <div className="workbench-ribbon-tabs" role="tablist" aria-label="功能分类">{WORKBENCH_TABS.map((item, index) => <button key={item.label} id={`ribbon-tab-${index}`} type="button" role="tab" aria-selected={item.label === activeTab} aria-controls="ribbon-commands" tabIndex={item.label === activeTab ? 0 : -1} onClick={() => setActiveTab(item.label)} onKeyDown={(event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? WORKBENCH_TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + WORKBENCH_TABS.length) % WORKBENCH_TABS.length; setActiveTab(WORKBENCH_TABS[next].label); document.getElementById(`ribbon-tab-${next}`)?.focus(); }
    }}>{item.label}</button>)}</div>
    <div id="ribbon-commands" className="workbench-ribbon-content" role="tabpanel" aria-labelledby={`ribbon-tab-${WORKBENCH_TABS.indexOf(tab)}`}>{tab.groups.map((group) => <div className="workbench-tool-group" key={group.label}><div className="ribbon-tools">{group.tools.map(({ id, label, icon }) => {
      const state = availability(id);
      const primitiveKind = id.startsWith("primitive.") ? id.slice("primitive.".length) as Parameters<typeof PrimitiveToolIcon>[0]["kind"] : null;
      return <button className={`workbench-tool${state.active ? " active" : ""}`} type="button" key={label} data-command={id} disabled={!state.enabled} title={state.enabled ? label : `${label} · ${state.reason || "当前不可用"}`} aria-pressed={state.active} onClick={() => onCommand(id)}>{primitiveKind ? <PrimitiveToolIcon kind={primitiveKind} /> : <StudioIcon name={icon} size={25} />}<span>{label}</span></button>;
    })}</div><small>{group.label}</small></div>)}</div>
  </section>;
}
