"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { StudioIcon } from "./StudioIcon";

export function WorkbenchDialog({ title, children, actions, onCancel, busy = false, className }: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onCancel: () => void;
  busy?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const trigger = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-initial-focus]:not(:disabled)")?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      const remaining = Array.from(document.querySelectorAll("dialog:modal"));
      if (trigger instanceof HTMLElement && trigger.isConnected &&
          (!remaining.length || remaining.some(parent => parent.contains(trigger)))) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  return <dialog ref={ref} className={["workbench-confirmation", actions && "structured-dialog", className].filter(Boolean).join(" ")} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !busy) onCancel();
    }}>
    <header className="dialog-heading">
      <h2 id={titleId}>{title}</h2>
      <button type="button" aria-label="关闭弹窗" title="关闭（Esc）" disabled={busy} onClick={onCancel}><StudioIcon name="close" /></button>
    </header>
    {actions ? <>
      <div className="dialog-body" aria-busy={busy}>{children}</div>
      <footer className="dialog-footer">
        {busy && <span role="status" className="dialog-progress">正在处理…</span>}
        <fieldset className="modal-actions" aria-label="弹窗操作" disabled={busy}>{actions}</fieldset>
      </footer>
    </> : children}
  </dialog>;
}
