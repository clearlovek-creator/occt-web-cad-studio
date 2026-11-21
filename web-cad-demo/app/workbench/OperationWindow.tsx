"use client";

import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from "react";

export function OperationWindow({
  title,
  subtitle,
  onClose,
  children,
  docked = false,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
  docked?: boolean;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [minimized, setMinimized] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number; minX: number; maxX: number; minY: number; maxY: number } | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !panelRef.current?.closest("[hidden]") && !(event.target instanceof HTMLSelectElement)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  useEffect(() => {
    if (docked) return;
    const panel = panelRef.current;
    const workspace = panel?.parentElement;
    if (!panel || !workspace) return;
    const observer = new ResizeObserver(() => {
      const bounds = workspace.getBoundingClientRect(), rect = panel.getBoundingClientRect();
      const dx = rect.left < bounds.left ? bounds.left - rect.left : rect.right > bounds.right ? bounds.right - rect.right : 0;
      const dy = rect.top < bounds.top ? bounds.top - rect.top : rect.bottom > bounds.bottom ? bounds.bottom - rect.bottom : 0;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) setOffset((current) => ({ x: current.x + dx, y: current.y + dy }));
    });
    observer.observe(workspace);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [docked]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (docked || (event.target as HTMLElement).closest("button")) return;
    if (event.button !== 0) return;
    const panel = event.currentTarget.parentElement;
    const workspace = panel?.parentElement;
    if (!panel || !workspace) return;
    const panelRect = panel.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const baseLeft = panelRect.left - offset.x;
    const baseTop = panelRect.top - offset.y;
    const minX = workspaceRect.left - baseLeft;
    const minY = workspaceRect.top - baseTop;
    dragRef.current = {
      x: event.clientX, y: event.clientY, originX: offset.x, originY: offset.y,
      minX, maxX: Math.max(minX, workspaceRect.right - panelRect.width - baseLeft),
      minY, maxY: Math.max(minY, workspaceRect.bottom - Math.min(panelRect.height, workspaceRect.height) - baseTop),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({
      x: Math.max(drag.minX, Math.min(drag.maxX, drag.originX + event.clientX - drag.x)),
      y: Math.max(drag.minY, Math.min(drag.maxY, drag.originY + event.clientY - drag.y)),
    });
  };
  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <section
      ref={panelRef}
      className={`operation-window${minimized ? " minimized" : ""}${docked ? " docked-operation" : ""}`}
      style={docked ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px)` }}
      role="dialog"
      aria-modal="false"
      aria-label={title}
      data-testid="operation-window"
    >
      <header className="operation-window-header" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={() => { dragRef.current = null; }}>
        <div><strong>{title}</strong><small>{subtitle}</small></div>
        <div className="operation-window-controls">
          <button type="button" onClick={() => setMinimized((value) => !value)} aria-label={minimized ? "展开操作窗口" : "最小化操作窗口"}>{minimized ? "□" : "—"}</button>
          <button type="button" onClick={onClose} aria-label="关闭操作窗口">×</button>
        </div>
      </header>
      <div className="operation-window-body" hidden={minimized}>{children}</div>
    </section>
  );
}
