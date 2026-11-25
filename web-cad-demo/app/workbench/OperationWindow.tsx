"use client";

import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { StudioIcon } from "./StudioIcon";

export function OperationWindow({
  title,
  subtitle,
  onClose,
  children,
  docked = false,
  wide = false,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
  docked?: boolean;
  wide?: boolean;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [minimized, setMinimized] = useState(false);
  const [side, setSide] = useState<"left" | "right">("right");
  const bodyId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number; minX: number; maxX: number; minY: number; maxY: number } | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || panel.closest("[hidden]")) return;
    const trigger = document.activeElement;
    if (!panel.contains(trigger)) panel.focus({ preventScroll: true });
    return () => {
      if (panel.contains(document.activeElement) && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

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
      className={`operation-window${minimized ? " minimized" : ""}${docked ? " docked-operation" : ""}${wide && !docked ? " wide-operation" : ""}`}
      style={docked ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px)` }}
      data-side={docked ? undefined : side}
      role="dialog"
      aria-modal="false"
      aria-label={title}
      tabIndex={-1}
      data-testid="operation-window"
      onKeyDown={event => {
        if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing) return;
        if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target) || event.target.closest("select, dialog[open]")) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="operation-window-header" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={() => { dragRef.current = null; }}>
        <div className="operation-window-caption"><strong>{title}</strong><small title={subtitle}>{subtitle}</small></div>
        <div className="operation-window-controls">
          {!docked && <button type="button" className="operation-window-reposition" aria-label={side === "right" ? "移到视口左侧" : "移到视口右侧"} title={side === "right" ? "移到视口左侧" : "移到视口右侧"} onClick={() => {
            setSide(side === "right" ? "left" : "right");
            setOffset({ x: 0, y: 0 });
          }}><StudioIcon name={side === "right" ? "dockLeft" : "dockRight"} /></button>}
          <button type="button" onClick={() => setMinimized((value) => !value)} aria-expanded={!minimized} aria-controls={bodyId} aria-label={minimized ? "展开操作窗口" : "最小化操作窗口"} title={minimized ? "展开" : "最小化"}><StudioIcon name={minimized ? "expand" : "minus"} /></button>
          <button type="button" onClick={onClose} aria-label="关闭操作窗口" title="关闭（Esc）"><StudioIcon name="close" /></button>
        </div>
      </header>
      <div className="operation-window-body" id={bodyId} hidden={minimized}>{children}</div>
    </section>
  );
}
