import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("keeps native control implementations inside the shared foundation", () => {
 const root = new URL("./", import.meta.url);
 for (const name of readdirSync(root).filter(name => name.endsWith(".tsx") && !name.includes(".test.") && !name.startsWith("test-"))) {
  const source = readFileSync(new URL(name,root),"utf8");
  expect(source, name).not.toMatch(/<(?:button|input|textarea|select|option|table|thead|tbody|tr|th|td|details|summary|progress)\b/);
  expect(source, name).not.toMatch(/role="(?:tablist|combobox|listbox)"/);
 }
});
it("loads one token foundation with separately owned workspace styles", () => {
 const main=readFileSync(new URL("./main.tsx",import.meta.url),"utf8");
 expect(main.match(/import "\.\/[^\"]+\.css";/g)).toEqual(['import "./shadcn.css";', 'import "./workspace-layout.css";', 'import "./workspace-shell.css";', 'import "./project-workspace.css";', 'import "./specialist-journey.css";']);
 const layout=readFileSync(new URL("./workspace-layout.css",import.meta.url),"utf8");expect(layout).not.toMatch(/--(?:background|foreground|primary|surface|ink|accent)\s*:/);
});
