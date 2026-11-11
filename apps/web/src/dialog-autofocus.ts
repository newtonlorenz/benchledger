/**
 * Dialog content can arrive after the dialog opens (for example a lazily
 * loaded panel behind Suspense). When an explicit `data-autofocus` control
 * appears later, move focus to it — but only while focus is still where the
 * dialog put it on open, so a user who has already moved on keeps their place.
 * Returns a disposer.
 */
export function watchLateAutofocus(container: HTMLElement, initialFocus: Element | null): () => void {
  if (typeof MutationObserver === "undefined") return () => undefined;
  const untouched = () => {
    const active = document.activeElement;
    return active === initialFocus || active === container || active === document.body || active === null;
  };
  const observer = new MutationObserver(() => {
    const target = container.querySelector<HTMLElement>("[data-autofocus]");
    if (!target || target === initialFocus) return;
    observer.disconnect();
    if (untouched()) target.focus({ preventScroll: true });
  });
  observer.observe(container, { childList: true, subtree: true });
  return () => observer.disconnect();
}
