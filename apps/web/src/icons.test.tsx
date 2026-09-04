import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, type IconName } from "./icons";

const iconNames: IconName[] = [
  "arrow-left", "arrow-right", "arrow-up-right", "archive", "box", "check", "check-circle",
  "chevron-down", "chevron-right", "circle", "clipboard", "clock", "close", "code", "copy", "circuit", "download", "external", "file", "filter", "folder", "grid", "help", "info", "layers", "link",
  "menu", "minus", "package", "plus", "refresh", "search", "settings", "sliders", "spark", "spool", "tag",
  "tool", "trash", "upload", "warning", "wrench"
];

describe("Icon", () => {
  it("renders every public icon name as an accessible, non-focusable SVG", () => {
    for (const name of iconNames) {
      const markup = renderToStaticMarkup(<Icon name={name} />);
      expect(markup, name).toContain("<svg");
      expect(markup, name).toContain('aria-hidden="true"');
      expect(markup, name).toContain('focusable="false"');
      expect(markup, name).toContain("currentColor");
      expect(markup, name).toMatch(/<(?:path|circle|rect)/);
    }
  });

  it("passes size, stroke, and SVG attributes through for dense UI contexts", () => {
    const markup = renderToStaticMarkup(<Icon name="settings" size={24} strokeWidth={2.5} className="test-icon" data-testid="settings-icon" />);
    expect(markup).toContain('width="24"');
    expect(markup).toContain('height="24"');
    expect(markup).toContain('stroke-width="2.5"');
    expect(markup).toContain('class="test-icon"');
    expect(markup).toContain('data-testid="settings-icon"');
  });
});
