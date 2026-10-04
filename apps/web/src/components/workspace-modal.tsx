import * as React from "react";
import { Dialog, DialogContent } from "./ui/dialog";
import { AlertDialog, AlertDialogContent } from "./ui/alert-dialog";
import { Sheet, SheetContent } from "./ui/sheet";

/** A popover action disappears when the modal takes focus; retain its launcher. */
function returnFocusTarget(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  // First-use actions can disappear after a save. Return to their persistent
  // equivalent instead of leaving keyboard users at the document body.
  const persistentTarget = active.dataset.focusReturn;
  if (persistentTarget) return document.getElementById(persistentTarget) ?? active;
  const popover = active.closest<HTMLElement>('[data-slot="popover-content"]');
  if (popover?.id) {
    return [...document.querySelectorAll<HTMLElement>('[aria-controls]')]
      .find(element => element.getAttribute("aria-controls") === popover.id) ?? active;
  }
  return active;
}

/** One Radix focus/dismissal boundary. Domain callbacks retain all save/approval guards. */
export function WorkspaceModal({ children, onClose, active = true, kind = "dialog" }: {
  children: React.ReactElement; onClose(): void; active?: boolean; kind?: "dialog" | "alertdialog" | "sheet";
}) {
  const previous = React.useRef<HTMLElement | null>(returnFocusTarget());
  const content = React.useRef<HTMLDivElement>(null);
  const focus = (event: Event) => {
    event.preventDefault();
    const dialog = content.current;
    const target = dialog?.querySelector<HTMLElement>('[data-autofocus], [autofocus]') ?? dialog?.querySelector<HTMLElement>('form input:not([disabled]), form textarea:not([disabled]), form select:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ?? dialog?.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]');
    target?.focus({ preventScroll: true });
  };
  const restore = (event: Event) => {
    event.preventDefault();
    window.setTimeout(() => {
      const target = previous.current, current = document.activeElement;
      if (!target?.isConnected || target.closest('[inert]')) return;
      if (current instanceof HTMLElement && current !== document.body && current !== target && current.isConnected && !current.closest('[inert]')) return;
      target.focus({ preventScroll: true });
    }, 0);
  };
  const escape = (event: KeyboardEvent) => {
    // A suspended editor remains mounted to retain its draft, but cannot dismiss.
    event.preventDefault();
    if (content.current?.closest('[inert]')) return;
    // Closing synchronously can reactivate the parent layer during this key event.
    event.stopImmediatePropagation();
    onClose();
  };
  const change = (open: boolean) => { if (!open) onClose(); };
  if (kind === "alertdialog") return <AlertDialog open={active} onOpenChange={change}><AlertDialogContent ref={content} asChild aria-modal="true" onEscapeKeyDown={escape} aria-describedby={undefined} onOpenAutoFocus={focus} onCloseAutoFocus={restore}>{children}</AlertDialogContent></AlertDialog>;
  if (kind === "sheet") return <Sheet open={active} onOpenChange={change}><SheetContent ref={content} asChild showCloseButton={false} aria-modal="true" onEscapeKeyDown={escape} aria-describedby={undefined} onOpenAutoFocus={focus} onCloseAutoFocus={restore}>{children}</SheetContent></Sheet>;
  return <Dialog open={active} onOpenChange={change}><DialogContent ref={content} asChild showCloseButton={false} aria-modal="true" onEscapeKeyDown={escape} aria-describedby={undefined} onOpenAutoFocus={focus} onCloseAutoFocus={restore}>{children}</DialogContent></Dialog>;
}
