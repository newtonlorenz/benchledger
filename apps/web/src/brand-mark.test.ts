import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const faviconSource = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");

describe("BenchLedger brand mark", () => {
  it("keeps the runtime mark and favicon on the same three-bar geometry", () => {
    const runtimeMark = appSource.match(/function BrandMark\(\).*?<\/div> \); \}/u)?.[0];

    expect(runtimeMark).toBeDefined();
    expect(runtimeMark).toContain('className="brand-mark" aria-hidden="true"');
    expect(runtimeMark?.match(/<span \/>/gu)).toHaveLength(3);
    expect(stylesSource).toMatch(/\.brand-mark\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\);[^}]*gap:\s*3px;[^}]*padding:\s*5px;/u);
    expect(stylesSource).toContain(".brand-mark span:nth-child(1) { height: 48%; }");
    expect(stylesSource).toContain(".brand-mark span:nth-child(2) { height: 78%; }");
    expect(stylesSource).toContain(".brand-mark span:nth-child(3) { height: 100%; }");
    expect(stylesSource).toContain("background: #1F4A40");
    expect(stylesSource).toContain("background: #A5D5AF");

    expect(faviconSource).toContain('viewBox="0 0 28 28"');
    expect(faviconSource).toContain('fill="#1F4A40"');
    expect(faviconSource).toContain('fill="#A5D5AF"');
    expect(faviconSource).not.toContain("<path");
    expect(faviconSource.match(/<rect\b/gu)).toHaveLength(4);
    expect(faviconSource).toContain('x="6" y="14.3" width="3.33" height="7.7"');
    expect(faviconSource).toContain('x="12.33" y="9.5" width="3.33" height="12.5"');
    expect(faviconSource).toContain('x="18.67" y="6" width="3.33" height="16"');
  });
});
