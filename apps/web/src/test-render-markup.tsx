import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
/** Includes portalled dialogs: these workflows are client UI, not SSR output. */
export function renderToStaticMarkup(element: ReactNode): string {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try { flushSync(() => root.render(element)); return document.body.innerHTML.replace(/="[^"]*"/g, value => value.replaceAll(">", "&gt;").replaceAll("<", "&lt;")); }
  finally { flushSync(() => root.unmount()); container.remove(); }
}
