"use client";

import { useId, useState } from "react";
import { StudioIcon } from "./StudioIcon";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { WORKBENCH_TABS, type WorkbenchCommand } from "./ribbon-catalog";

const commands = WORKBENCH_TABS.flatMap(tab => tab.groups.flatMap(group =>
  group.tools.map(tool => ({ ...tool, category: tab.label, group: group.label })),
));

export function CommandSearch({ availability, onRun, onClose }: {
  availability: (id: WorkbenchCommand) => { enabled: boolean; reason?: string };
  onRun: (id: WorkbenchCommand) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  const listId = useId();
  const keywords = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const results = commands.filter(command => {
    const description = `${command.label} ${command.id} ${command.category} ${command.group}`.toLowerCase();
    return keywords.every(keyword => description.includes(keyword));
  }).map(command => ({ ...command, ...availability(command.id) }));
  const enabled = results.flatMap((row, index) => row.enabled ? [index] : []);
  const active = enabled.includes(cursor) ? cursor : (enabled[0] ?? -1);

  function select(index: number) {
    const command = results[index];
    if (command?.enabled) onRun(command.id);
  }

  return <WorkbenchDialog title="查找命令" onCancel={onClose} className="command-search-dialog">
    <div className="command-search-input">
      <StudioIcon name="search" size={19} />
      <input data-initial-focus role="combobox" aria-label="命令名称或 ID" autoComplete="off"
        aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={active < 0 ? undefined : `${listId}-${active}`}
        placeholder="搜索命令名称、功能分类或 ID" value={query}
        onChange={event => { setQuery(event.target.value); setCursor(-1); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); select(active); return; }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!enabled.length) return;
          const step = event.key === "ArrowDown" ? 1 : -1;
          const next = enabled[(enabled.indexOf(active) + step + enabled.length) % enabled.length];
          setCursor(next);
          document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" });
        }} />
      <kbd>Esc</kbd>
    </div>
    <div className="command-search-results" id={listId} role="listbox" aria-label="匹配命令">
      {results.map((command, index) => <div id={`${listId}-${index}`} key={`${command.category}:${command.group}:${command.id}`}
        role="option" aria-selected={active === index} aria-disabled={!command.enabled}
        onPointerMove={() => { if (command.enabled && active !== index) setCursor(index); }} onClick={() => select(index)}>
        <StudioIcon name={command.icon} size={20} />
        <span><strong>{command.label}</strong><small>{command.category} / {command.group}</small></span>
        {command.enabled ? <code>{command.id}</code> : <small>{command.reason || "当前不可用"}</small>}
      </div>)}
    </div>
    <footer className="command-search-footer">
      <span role="status">{results.length ? `${results.length} 项命令` : "未找到匹配命令"}</span>
      <span><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>Enter</kbd> 执行</span>
    </footer>
  </WorkbenchDialog>;
}
