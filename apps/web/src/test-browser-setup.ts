import { beforeEach } from "vitest";
// jsdom has no layout engine. Browser interaction/geometry is verified by Playwright.
beforeEach(() => {
  if (typeof window === "undefined") return;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.scrollIntoView ??= function () {};
});
