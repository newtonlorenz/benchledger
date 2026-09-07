import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/** Isolate an inline modal without changing the surrounding router or record state. */
export function useModalBoundary(ref: RefObject<HTMLElement | null>, close: () => void, active = true): void {
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const modal = ref.current;
    if (!active || !modal) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const siblings = new Map<HTMLElement, boolean>();
    for (let node: HTMLElement | null = modal; node && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement?.children ?? []) {
        if (sibling === node || !(sibling instanceof HTMLElement) || ["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) continue;
        siblings.set(sibling, sibling.hasAttribute("inert")); sibling.setAttribute("inert", "");
      }
    }
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const controls = () => [...modal.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], summary, [tabindex]")].filter((element) => !element.matches(":disabled, [tabindex='-1'], [type='hidden']") && !element.closest("[inert]") && element.getClientRects().length > 0);
    const initial = modal.querySelector<HTMLElement>("[data-autofocus]") ?? controls()[0] ?? modal;
    initial.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (modal.closest("[inert]")) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      // WebKit can skip native buttons when full keyboard access is off.
      // Advance every Tab explicitly so approval controls behave consistently.
      event.preventDefault();
      const candidates = controls();
      const index = candidates.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? 0 : (index + (event.shiftKey ? -1 : 1) + candidates.length) % candidates.length;
      (candidates[next] ?? modal).focus();
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      for (const [element, wasInert] of siblings) if (!wasInert) element.removeAttribute("inert");
      document.body.style.overflow = overflow;
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true });
    };
  }, [active, ref]);
}
