import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { ConnectionScreen } from "./App";

describe("ConnectionScreen", () => {
  const actions = { onLogin: vi.fn(), onRetry: vi.fn(), onSample: vi.fn() };

  it("keeps the password form behind the authentication boundary", () => {
    const signedOut = renderToStaticMarkup(<ConnectionScreen state="unauthenticated" error={undefined} demoAvailable={false} {...actions} />);
    const integrityFailure = renderToStaticMarkup(<ConnectionScreen state="error" error={new ApiError("The service returned inconsistent project readiness", { kind: "server", status: 502 })} demoAvailable={false} {...actions} />);

    expect(signedOut).toContain("Workspace password");
    expect(integrityFailure).toContain("Cannot open workspace");
    expect(integrityFailure).toContain("The service returned inconsistent project readiness");
    expect(integrityFailure).not.toContain("Workspace password");
  });

  it("labels sample records as practice data before sign-in", () => {
    const sampleChoice = renderToStaticMarkup(<ConnectionScreen state="unauthenticated" error={undefined} demoAvailable {...actions} />);

    expect(sampleChoice).toContain("Sample records are for practice");
    expect(sampleChoice).not.toContain("synthetic");
  });
});
