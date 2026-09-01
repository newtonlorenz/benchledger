import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LAN_OPEN_WARNING, WorkspaceAccessSection } from "./workspace-access";

describe("workspace access settings", () => {
  it("labels LAN-open mode and displays the exact trusted-network warning", () => {
    const markup = renderToStaticMarkup(<WorkspaceAccessSection access={{ mode: "lan_open", demo: false, version: 7 }} onUpdate={vi.fn()} onChanged={vi.fn()} onRebootstrap={vi.fn()} />);
    expect(markup).toContain("LAN open");
    expect(markup).toContain(LAN_OPEN_WARNING);
    expect(markup).toContain("Enable workspace password");
    expect(markup).toContain('aria-label="Enable workspace password"');
    expect(markup).toContain('autoComplete="new-password"');
    expect(markup).not.toContain("private/secure");
  });

  it("labels password mode, keeps MCP bearer-token guidance, and requires current password to change", () => {
    const markup = renderToStaticMarkup(<WorkspaceAccessSection access={{ mode: "password", demo: false, version: 8 }} onUpdate={vi.fn()} onChanged={vi.fn()} onRebootstrap={vi.fn()} />);
    expect(markup).toContain("Password required");
    expect(markup).toContain('aria-label="Change workspace password"');
    expect(markup).toContain("Current workspace password");
    expect(markup).toContain("Disable password protection");
    expect(markup).toContain("Bearer tokens for MCP agents remain required");
  });
});
