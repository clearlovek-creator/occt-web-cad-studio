"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { StudioIcon } from "./StudioIcon";

export type TreeAction = { label: string; run: () => void | Promise<unknown>; disabled?: boolean; reason?: string; danger?: boolean };

/** Shared mouse and keyboard context actions for both workbench trees. */
export function ContextActions({ label, actions, children, className = "" }: { label: string; actions: TreeAction[]; children: ReactNode; className?: string }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = (x: number, y: number) => {
    const focused = document.activeElement;
    returnFocus.current = focused instanceof HTMLElement && row.current?.contains(focused) ? focused : trigger.current;
    setPosition({ x, y });
  };
  const close = (restore = false) => { setPosition(null); if (restore) returnFocus.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const bounds = menu.current.getBoundingClientRect();
    menu.current.style.left = `${Math.max(4, Math.min(position.x, window.innerWidth - bounds.width - 4))}px`;
    menu.current.style.top = `${Math.max(4, Math.min(position.y, window.innerHeight - bounds.height - 4))}px`;
    (menu.current.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu.current).focus({ preventScroll: true });
  }, [position]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setPosition(null);
    };
    const outsideWheel = (event: WheelEvent) => { if (!menu.current?.contains(event.target as Node)) setPosition(null); };
    const dismiss = () => setPosition(null);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("wheel", outsideWheel, { passive: true });
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("resize", dismiss); window.removeEventListener("wheel", outsideWheel); };
  }, [position]);
  return <div ref={row} className={`managed-tree-row ${className}`} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); open(event.clientX, event.clientY); }} onKeyDown={(event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); event.stopPropagation(); const rect = row.current!.getBoundingClientRect(); open(rect.left + 24, rect.bottom); }
  }}>
    {children}
    <button ref={trigger} type="button" className="tree-more" aria-label={`${label}操作`} aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); if (position) close(true); else open(rect.left, rect.bottom); }}><StudioIcon name="dots" size={14} /></button>
    {position && createPortal(<div ref={menu} className="tree-context-menu" role="menu" tabIndex={-1} aria-label={`${label}操作`} style={{ left: position.x, top: position.y }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={(event) => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === "Tab") close();
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); if (!items.length) return; const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items[index]?.focus(); }
    }}>{actions.map((action, index) => <button type="button" role="menuitem" key={`${action.label}-${index}`} disabled={action.disabled} title={action.reason} className={action.danger ? "danger" : ""} onClick={() => { close(true); void action.run(); }}>{action.label}{action.disabled && action.reason && <small>{action.reason}</small>}</button>)}</div>, document.body)}
  </div>;
}

export function MeshIcon() {
  return <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M2 2h14v14H2zM2 6.67h14M2 11.33h14M6.67 2v14M11.33 2v14" /></svg>;
}

export function EyeIcon({ hidden = false }: { hidden?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6Z" /><circle cx="10" cy="10" r="2.5" />{hidden && <path d="m2 2 16 16" />}</svg>;
}
