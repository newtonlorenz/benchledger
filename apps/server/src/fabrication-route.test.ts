import { describe, expect, it } from "vitest";
import { ApplicationService } from "@benchledger/application";
import { createApp } from "./app.js";
import { createSyntheticRuntime } from "./memory-store.js";

const demoPassword = "demo-password-please-change";

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

describe("fabrication route transport", () => {
  it("carries route and printer planning through atomic and later memory revisions", async () => {
    const runtime = createSyntheticRuntime();
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "route-test", source: "api" as const, correlationId: "route-test", scopes: new Set(["projects:write"]) };
    await expect(service.createProjectRevision("synthetic-project-lamp", { id: "memory-omitted-route-invalid", name: "Invalid", status: "concept", intendedPrinterItemId: "printer-h2d" }, context))
      .rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/printed fabrication route/i) });
    await expect(Promise.resolve().then(() => runtime.ports.projects.createProjectRevision("synthetic-project-lamp", { id: "memory-adapter-omitted-route-invalid", name: "Invalid", status: "concept", intendedPrinterItemId: "printer-h2d" }, context)))
      .rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/printed fabrication route/i) });
    await expect(runtime.ports.projects.createProjectWithInitialRevision!({
      project: { id: "memory-atomic-omitted-route-invalid-project", name: "Atomic invalid route", status: "planned" },
      revision: { id: "memory-atomic-omitted-route-invalid-revision", name: "Invalid", status: "concept", intendedPrinterItemId: "printer-h2d" }
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/printed fabrication route/i) });
    const setupContext = { ...context, scopes: new Set(["projects:write", "bom:write"]) };
    const setupPreview = await service.previewProjectSetup({
      project: { id: "memory-setup-route-project", name: "Memory setup route project", status: "planned" },
      revision: { id: "memory-setup-route-revision", name: "Printed setup", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d" },
      workItems: [],
      bomLines: [{ localRef: "setup-line", id: "memory-setup-route-line", name: "Setup requirement", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: []
    }, setupContext);
    const unownedPrinterPreview = structuredClone(setupPreview);
    unownedPrinterPreview.proposal.revision.intendedPrinterItemId = "missing-setup-printer";
    await expect(runtime.ports.projectSetups!.commitPreview({
      preview: unownedPrinterPreview,
      command: { previewId: setupPreview.id, expectedPreviewVersion: setupPreview.version, contentSha256: setupPreview.contentSha256, confirmReservations: false },
      actor: setupContext.actor, source: setupContext.source, correlationId: setupContext.correlationId
    })).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/inventory item/i) });
    const initial = await service.createProjectWithInitialRevision({
      project: { id: "route-project", name: "Route project", status: "planned" },
      revision: { id: "route-revision-1", name: "Printed baseline", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d" }
    }, context);
    expect(initial.data.revision).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d" });

    const carried = await service.createProjectRevision(initial.data.project.id, { id: "route-revision-2", name: "Carried baseline", status: "concept" }, context);
    expect(carried.data).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d" });
    const cleared = await service.updateProjectRevision(carried.data.id, { intendedPrinterItemId: null }, carried.data.version, context);
    expect(cleared.data).toMatchObject({ fabricationRoute: "printed" });
    expect(cleared.data).toMatchObject({ intendedPrinterItemId: null });
    const carriedClear = await service.createProjectRevision(initial.data.project.id, { id: "route-revision-clear-carry", name: "Cleared carry", status: "concept" }, context);
    expect(carriedClear.data).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: null });
    const changed = await service.updateProjectRevision(cleared.data.id, { fabricationRoute: "ready_made" }, cleared.data.version, context);
    expect(changed.data).toMatchObject({ fabricationRoute: "ready_made" });
    expect(changed.data).toMatchObject({ intendedPrinterItemId: null });
    expect(() => runtime.ports.projects.updateProjectRevision!(cleared.data.id, { fabricationRoute: "ready_made", intendedPrinterItemId: "printer-h2d" }, changed.data.version, context))
      .toThrow(/printed fabrication route/i);

    const explicitNone = await service.createProjectRevision(initial.data.project.id, {
      name: "Electronics only", notes: "No fabricated enclosure", status: "concept", fabricationRoute: "none"
    }, context);
    expect(explicitNone.data.id).toMatch(/^revision-/u);
    expect(explicitNone.data).toMatchObject({ fabricationRoute: "none", notes: "No fabricated enclosure" });

    expect(() => runtime.ports.projects.createProjectRevision(initial.data.project.id, {
      id: carried.data.id, name: "Duplicate", status: "concept", fabricationRoute: "none"
    }, context)).toThrow(/already exists/i);
    expect(() => runtime.ports.projects.updateProjectRevision!("missing-route-revision", { fabricationRoute: "none" }, 1, context))
      .toThrow(/not found/i);

    const printedWithoutPrinter = await runtime.ports.projects.updateProjectRevision!(explicitNone.data.id, { fabricationRoute: "printed" }, explicitNone.data.version, context);
    expect(printedWithoutPrinter).toMatchObject({ fabricationRoute: "printed" });
    expect(printedWithoutPrinter).toMatchObject({ intendedPrinterItemId: null });
    const selectedAgain = await runtime.ports.projects.updateProjectRevision!(printedWithoutPrinter.id, {
      fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d"
    }, printedWithoutPrinter.version, context);
    expect(selectedAgain).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d" });

    await service.createProjectRevision(initial.data.project.id, {
      name: "Reset to electronics", status: "concept", fabricationRoute: "none"
    }, context);
    const printedLater = await service.createProjectRevision(initial.data.project.id, {
      name: "Printed without assignment", status: "concept", fabricationRoute: "printed"
    }, context);
    expect(printedLater.data).toMatchObject({ fabricationRoute: "printed" });
    expect(printedLater.data).toMatchObject({ intendedPrinterItemId: null });
    const assignedOnCreate = await service.createProjectRevision(initial.data.project.id, {
      name: "Printed with assignment", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d"
    }, context);
    expect(assignedOnCreate.data).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d" });
  });

  it("serves the narrow revision update over HTTP with If-Match", async () => {
    const runtime = createSyntheticRuntime();
    const app = await createApp({ runtime, demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const csrf = login.json<{ csrfToken: string }>().csrfToken;
      const headers = { cookie, "x-csrf-token": csrf };
      const revisionId = "synthetic-revision-lamp-r01";
      const initial = await app.inject({ method: "GET", url: `/api/v1/project-revisions/${revisionId}`, headers: { cookie } });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({ fabricationRoute: "undecided" });

      const invalidOmittedRoute = await app.inject({
        method: "POST",
        url: "/api/v1/projects/synthetic-project-lamp/revisions",
        headers,
        payload: { name: "Invalid omitted route", status: "concept", intendedPrinterItemId: "printer-h2d" }
      });
      expect(invalidOmittedRoute.statusCode).toBe(400);

      const invalidAtomicOmittedRoute = await app.inject({
        method: "POST",
        url: "/api/v1/projects/with-initial-revision",
        headers,
        payload: {
          project: { id: "http-atomic-omitted-route-invalid-project", name: "HTTP atomic invalid route", status: "planned" },
          revision: { id: "http-atomic-omitted-route-invalid-revision", name: "Invalid", status: "concept", intendedPrinterItemId: "printer-h2d" }
        }
      });
      expect(invalidAtomicOmittedRoute.statusCode).toBe(400);

      const printed = await app.inject({
        method: "PATCH",
        url: `/api/v1/project-revisions/${revisionId}`,
        headers: { ...headers, "if-match": "1" },
        payload: { fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d" }
      });
      expect(printed.statusCode).toBe(200);
      expect(printed.json()).toMatchObject({ data: { fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d", version: 2 } });

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/v1/project-revisions/${revisionId}`,
        headers: { ...headers, "if-match": "2" },
        payload: { intendedPrinterItemId: null }
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ data: { fabricationRoute: "printed", version: 3 } });
      expect(cleared.json().data).toMatchObject({ intendedPrinterItemId: null });

      const clearedOnCreate = await app.inject({
        method: "POST",
        url: "/api/v1/projects/synthetic-project-lamp/revisions",
        headers,
        payload: { name: "Explicit clear", status: "concept", intendedPrinterItemId: null }
      });
      expect(clearedOnCreate.statusCode).toBe(201);
      expect(clearedOnCreate.json()).toMatchObject({ data: { fabricationRoute: "printed", intendedPrinterItemId: null } });

      const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
      expect(openapi.statusCode).toBe(200);
      expect(openapi.json()).toMatchObject({ paths: { "/project-revisions/{id}": { patch: expect.any(Object) }, "/projects/{id}/revisions": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProjectRevision" } } } } } } }, components: { schemas: { UpdateProjectRevision: expect.any(Object), CreateProjectRevision: expect.any(Object), FabricationRoute: expect.any(Object) } } });
    } finally {
      await app.close();
    }
  });
});
