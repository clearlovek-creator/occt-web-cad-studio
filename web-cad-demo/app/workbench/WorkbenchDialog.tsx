"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

export function WorkbenchDialog({ title, children, onCancel, busy = false }: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
  busy?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const trigger = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      dialog.close();
      if (!document.querySelector("dialog[open]") && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={ref} className="workbench-confirmation" aria-labelledby={titleId} aria-busy={busy}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !busy) onCancel();
    }}>
    <h2 id={titleId}>{title}</h2>
    {children}
  </dialog>;
}
