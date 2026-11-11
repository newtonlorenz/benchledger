import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon } from "./icons";

/**
 * Project switcher that only navigates on an explicit choice. Arrow keys on
 * a closed <select> fire `change` for every step in some browsers; those
 * keyboard steps stay pending until Enter or blur. A pointer choice (or a
 * programmatic selection) has no preceding navigation key and commits at once.
 */
export function ProjectSwitcher({ projects, value, onSelect }: { projects: readonly { id: string; name: string }[]; value: string; onSelect: (projectId: string) => void }) {
  const [pending, setPending] = useState<string>();
  const keyboardStep = useRef(false);
  useEffect(() => { setPending(undefined); }, [value]);
  const commit = () => {
    keyboardStep.current = false;
    if (pending !== undefined && pending !== value) onSelect(pending);
    setPending(undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSelectElement>) => {
    if (event.key === "Enter") { event.preventDefault(); commit(); return; }
    if (event.key === "Escape") { if (pending !== undefined) event.stopPropagation(); keyboardStep.current = false; setPending(undefined); return; }
    if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End" || event.key === "PageUp" || event.key === "PageDown" || event.key.length === 1) keyboardStep.current = true;
  };
  return (
    <select className="project-select" aria-label="Choose project" value={pending ?? value} onKeyDown={onKeyDown} onBlur={commit} onChange={(event) => {
      const next = event.target.value;
      if (keyboardStep.current) { setPending(next); return; }
      setPending(undefined);
      if (next !== value) onSelect(next);
    }}>
      {projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
    </select>
  );
}

/** Irreversible project deletion asks for the exact project name. */
export function DeleteProjectConfirmation({ projectName, busy, onConfirm, onCancel }: { projectName: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const matches = typed.trim() === projectName.trim();
  return (
    <form className="delete-project-confirmation" onSubmit={(event) => { event.preventDefault(); if (matches && !busy) onConfirm(); }}>
      <label className="form-field" htmlFor={inputId}><span>Type the project name <strong>{projectName}</strong> to confirm</span>
        <input id={inputId} autoComplete="off" spellCheck={false} value={typed} onChange={(event) => setTyped(event.target.value)} disabled={busy} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="button button-quiet" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="button button-danger" disabled={!matches || busy} aria-busy={busy || undefined}>{busy ? "Removing…" : "Delete project"}</button>
      </div>
    </form>
  );
}

/**
 * Visible "Record use" step. It opens the existing used-stock
 * (reconciliation) flow; when that flow is unavailable it stays visible and
 * says why instead of disappearing.
 */
export function RecordUseAction({ available, reason, onOpen, compact = false, label }: { available: boolean; reason?: string | undefined; onOpen: () => void; compact?: boolean; /** Accessible name when several rows show the action. A labelled row action keeps its reason for assistive technology only; the project strip shows it visibly. */ label?: string | undefined }) {
  const reasonId = useId();
  return (
    <span className={`record-use-action${compact ? " is-compact" : ""}`}>
      <button type="button" className={compact ? "text-button" : "button button-secondary"} disabled={!available} aria-label={label} aria-describedby={!available && reason ? reasonId : undefined} onClick={onOpen}><Icon name="check-circle" size={15} />Record use</button>
      {!available && reason && <small id={reasonId} className={label ? "sr-only" : "record-use-reason"}>{reason}</small>}
    </span>
  );
}

export interface OverflowMenuItem { id: string; label: string; onSelect: () => void; disabled?: boolean | undefined; danger?: boolean | undefined; icon?: Parameters<typeof Icon>[0]["name"] | undefined }

/**
 * Menu button (WAI-ARIA APG pattern): aria-haspopup/expanded on the button,
 * focus moves into the menu, Arrow/Home/End move between items, Escape and
 * Tab close it, and focus returns to the button after Escape or a choice.
 */
export function OverflowMenu({ label, items, className }: { label: string; items: readonly OverflowMenuItem[]; className?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const itemNodes = () => [...(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
  useEffect(() => {
    if (!open) return;
    const nodes = itemNodes();
    (initialFocus === "last" ? nodes[nodes.length - 1] : nodes[0])?.focus();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open, initialFocus]);
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) triggerRef.current?.focus(); };
  const openAt = (position: "first" | "last") => { setInitialFocus(position); setOpen(true); };
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openAt(event.key === "ArrowUp" ? "last" : "first"); }
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nodes = itemNodes();
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => { event.preventDefault(); nodes[(next + nodes.length) % nodes.length]?.focus(); };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(nodes.length - 1);
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "Tab") close(false);
  };
  return (
    <div className={`overflow-menu${className ? ` ${className}` : ""}`}>
      <button ref={triggerRef} type="button" className="button button-quiet overflow-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-label={label} onClick={() => (open ? close(false) : openAt("first"))} onKeyDown={onTriggerKeyDown}>
        <Icon name="more" size={17} /><span className="overflow-menu-text" aria-hidden="true">More</span>
      </button>
      {open && (
        <div ref={menuRef} id={menuId} className="overflow-menu-list" role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <button key={item.id} type="button" role="menuitem" tabIndex={-1} className={item.danger ? "is-danger" : undefined} aria-disabled={item.disabled || undefined} onClick={() => { if (item.disabled) return; close(true); item.onSelect(); }}>
              {item.icon && <Icon name={item.icon} size={15} />}{item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
