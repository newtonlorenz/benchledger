import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Download, type Locator, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, bearerRecord } from "../apps/server/dist/app.js";

const token = randomBytes(32).toString("hex");
const reviewDirectory = join(tmpdir(), "benchledger-library-review");
// Exact synthetic download bytes test integrity, not slicer readiness.
const printBytes = Buffer.from("PK\u0003\u0004Synthetic enclosure 3MF download fixture\n");
let app: Awaited<ReturnType<typeof createApp>>;
let origin: string;

test.beforeAll(async () => {
  // Exercise the actual bearer and session boundaries on an isolated demo host.
  app = await createApp({ demo: true, logger: false, auth: { sessionSecret: randomBytes(48).toString("hex"), bearerTokens: [bearerRecord(token, ["read", "write"], undefined, "synthetic-image-agent")] } });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  await mkdir(reviewDirectory, { recursive: true });
});

test.afterAll(async () => { await app?.close(); });

async function mcp<T = Record<string, unknown>>(request: APIRequestContext, name: string, arguments_: object): Promise<T> {
  const response = await request.post(`${origin}/api/v1/mcp`, {
    headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: arguments_ } },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json() as { error?: unknown; result?: { isError?: boolean; structuredContent?: T } };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError, JSON.stringify(body.result?.structuredContent)).not.toBe(true);
  expect(body.result?.structuredContent).toBeDefined();
  return body.result!.structuredContent!;
}

async function createProject(request: APIRequestContext, name: string) {
  const id = `gallery-${randomUUID()}`, revision = `${id}-r1`;
  await mcp(request, "create_project_with_initial_revision", { name, projectId: id, revisionId: revision, description: "Synthetic maker project for the project-image regression.", revisionSummary: "Initial design", fabricationRoute: "printed" });
  return { id, revision, name };
}

async function uploadImage(request: APIRequestContext, project: { id: string; revision: string }, bytes: Buffer, filename = "synthetic-enclosure-render.png") {
  const headers = { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const begin = await request.post(`${origin}/api/v1/artifacts/uploads`, { headers, data: { projectId: project.id, projectRevisionId: project.revision, filename, role: "photo", mediaType: "image/png", byteSize: bytes.length, sha256 } });
  expect(begin.status(), await begin.text()).toBe(201);
  const session = (await begin.json()).data as { id: string };
  const write = await request.put(`${origin}/api/v1/artifacts/uploads/${session.id}`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, data: bytes });
  expect(write.status(), await write.text()).toBe(200);
  const finalize = await request.post(`${origin}/api/v1/artifacts/uploads/${session.id}/finalize`, { headers: { ...headers, "idempotency-key": randomUUID() }, data: {} });
  expect(finalize.status(), await finalize.text()).toBe(200);
  const file = (await finalize.json()).data as { id: string; sha256: string };
  expect(file.sha256).toBe(sha256);
  return file;
}

async function signIn(page: Page) {
  await page.goto(origin);
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}

function projectCard(page: Page, name: string) {
  return page.locator(".home-project-row").filter({ has: page.getByRole("button", { name: `Open project ${name}`, exact: true }) });
}

async function expectDecodedImage(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(720);
}

async function syntheticProductImage(page: Page): Promise<Buffer> {
  // A recognisable synthetic test image catches broken decoding and layout;
  // this illustration is never presented as a manufactured or validated object.
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 720; canvas.height = 480;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#e7ecec"; ctx.fillRect(0, 0, 720, 480);
    ctx.fillStyle = "#152c34"; ctx.font = "bold 24px sans-serif";
    ctx.fillText("SYNTHETIC ENCLOSURE", 38, 49);
    ctx.font = "17px sans-serif"; ctx.fillText("Project image fixture · design concept", 38, 79);
    ctx.fillStyle = "#c2ccce"; ctx.beginPath(); ctx.ellipse(382, 363, 235, 39, 0, 0, Math.PI * 2); ctx.fill();
    const front = ctx.createLinearGradient(170, 220, 550, 360);
    front.addColorStop(0, "#e9bd73"); front.addColorStop(1, "#b47937");
    ctx.fillStyle = front; ctx.beginPath(); ctx.roundRect(170, 217, 352, 132, 20); ctx.fill();
    ctx.fillStyle = "#925d2d"; ctx.beginPath(); ctx.moveTo(520, 225); ctx.lineTo(589, 176); ctx.lineTo(589, 294); ctx.quadraticCurveTo(589, 310, 578, 318); ctx.lineTo(509, 350); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#f1d399"; ctx.beginPath(); ctx.moveTo(175, 220); ctx.lineTo(245, 161); ctx.lineTo(571, 161); ctx.quadraticCurveTo(592, 161, 589, 178); ctx.lineTo(520, 229); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#bb8c4f"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(189, 218); ctx.lineTo(252, 174); ctx.lineTo(561, 174); ctx.stroke();
    ctx.fillStyle = "#263d45"; ctx.beginPath(); ctx.roundRect(203, 249, 155, 46, 9); ctx.fill();
    ctx.fillStyle = "#63c6bd"; ctx.beginPath(); ctx.arc(472, 273, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#243b42"; ctx.font = "18px sans-serif"; ctx.fillText("ENCLOSURE / R01", 212, 330);
    ctx.font = "16px sans-serif"; ctx.fillText("Test fixture only", 38, 443);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const bytes = Buffer.from(base64, "base64");
  await writeFile(join(tmpdir(), "benchledger-project-render-fixture.png"), bytes);
  return bytes;
}

test("a chosen project render survives reload and stays visible in gallery and compact list", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const project = await createProject(request, "Gallery chosen enclosure");
  const cover = await uploadImage(request, project, await syntheticProductImage(page));
  await signIn(page);
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  const layout = page.getByRole("group", { name: "Project layout", exact: true });
  await expect(layout.getByRole("button", { name: "Gallery", exact: true })).toHaveAttribute("aria-pressed", "true");
  const card = projectCard(page, project.name);
  await card.getByRole("button", { name: `Choose image for ${project.name}`, exact: true }).click();
  await expect(page).toHaveURL(`${origin}/#/projects/${project.id}/files`);
  const editor = page.getByRole("region", { name: "Project image", exact: true });
  await editor.getByRole("button", { name: "Choose project image", exact: true }).click();
  await editor.getByRole("combobox", { name: "Project image file", exact: true }).selectOption(cover.id);
  await editor.getByRole("combobox", { name: "Image represents", exact: true }).selectOption("render");
  await editor.getByLabel("Image description", { exact: true }).fill("Synthetic enclosure design render");
  await expectDecodedImage(editor.getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(tmpdir(), "benchledger-project-image-editor-phone.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await editor.getByRole("button", { name: "Save project image", exact: true }).click();
  await expect(editor).toContainText("Project image saved.");
  await page.reload();
  await expect(editor).toContainText("Design render · synthetic-enclosure-render.png");
  await page.getByRole("button", { name: /^Projects/u }).click();
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  await expectDecodedImage(card.getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
  await expect(card).toContainText("Design render");
  await page.screenshot({ path: join(tmpdir(), "benchledger-project-gallery-desktop.png"), fullPage: true });
  expect((await new AxeBuilder({ page }).include(".home-projects").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);

  await layout.getByRole("button", { name: "List", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".home-project-list")).toBeVisible();
  await expectDecodedImage(card.getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(tmpdir(), "benchledger-project-list-phone.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(layout.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  await expectDecodedImage(card.getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
  await layout.getByRole("button", { name: "Gallery", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".project-gallery")).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expectDecodedImage(card.getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 390) await page.screenshot({ path: join(tmpdir(), "benchledger-project-gallery-phone.png"), fullPage: true });
  }
  await card.locator(".product-image-open").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Requirements/u })).toHaveAttribute("aria-selected", "true");
});

test("a later project revision never borrows the previous revision's render", async ({ page, request }) => {
  const project = await createProject(request, "Gallery revision enclosure");
  const cover = await uploadImage(request, project, await syntheticProductImage(page), "previous-revision-render.png");
  await mcp(request, "save_project_presentation", { projectId: project.id, projectRevisionId: project.revision, presentation: { expectedVersion: 0, coverArtifactId: cover.id, imageKind: "render", caption: "Earlier enclosure design" } });
  await signIn(page);
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  const card = projectCard(page, project.name);
  await expectDecodedImage(card.getByRole("img", { name: "Earlier enclosure design", exact: true }));
  await mcp(request, "create_project_revision", { projectId: project.id, summary: "New design without a render" });
  await page.reload();
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  await expect(card).toContainText("Show what you’re making");
  await expect(card.getByRole("img")).toHaveCount(0);
  await card.getByRole("button", { name: `Choose image for ${project.name}`, exact: true }).click();
  const editor = page.getByRole("region", { name: "Project image", exact: true });
  await expect(editor).toContainText("No image selected for this revision.");
  await editor.getByRole("button", { name: "Choose project image", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "Project image file" }).locator("option")).toHaveText(["No project image"]);
  await expect(editor).toContainText("Images must belong to this revision or a current work item.");
});

test("a corrupt render response shows a useful fallback and can be retried", async ({ page, request }) => {
  const project = await createProject(request, "Gallery retry enclosure");
  const cover = await uploadImage(request, project, await syntheticProductImage(page));
  await mcp(request, "save_project_presentation", { projectId: project.id, projectRevisionId: project.revision, presentation: { expectedVersion: 0, coverArtifactId: cover.id, imageKind: "reference", caption: "Synthetic enclosure reference" } });
  const path = `**/artifacts/${cover.id}/download`;
  await page.route(path, (route) => route.fulfill({ status: 200, contentType: "image/png", body: "Synthetic corrupt image response" }));
  await signIn(page);
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  const card = projectCard(page, project.name);
  await expect(card).toContainText("Image unavailable");
  await expect(card.getByRole("img")).toHaveCount(0);
  await expect(card.getByRole("button", { name: `Open project ${project.name}`, exact: true })).toBeEnabled();
  await page.unroute(path);
  await card.getByRole("button", { name: "Retry image", exact: true }).click();
  await expectDecodedImage(card.getByRole("img", { name: "Synthetic enclosure reference", exact: true }));
  await expect(card).toContainText("Reference image");
});

test("new image uploads are selectable immediately and a rejected save preserves the draft", async ({ page, request }) => {
  const project = await createProject(request, "Gallery uploaded enclosure");
  const bytes = await syntheticProductImage(page);
  await signIn(page);
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  await projectCard(page, project.name).getByRole("button", { name: `Choose image for ${project.name}`, exact: true }).click();
  const editor = page.getByRole("region", { name: "Project image", exact: true });
  await editor.getByRole("button", { name: "Choose project image", exact: true }).click();
  await expect(editor).toContainText("Upload a PNG, JPEG or WebP in Files first");
  await editor.getByRole("button", { name: "Cancel image selection", exact: true }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "uploaded-project-image.png", mimeType: "image/png", buffer: bytes });
  await page.getByRole("button", { name: "Add 1 file", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download uploaded-project-image.png", exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Choose project image", exact: true }).click();
  await editor.getByRole("combobox", { name: "Project image file", exact: true }).selectOption({ label: "uploaded-project-image.png" });
  await editor.getByRole("combobox", { name: "Image represents", exact: true }).selectOption("built_photo");
  await editor.getByLabel("Image description", { exact: true }).fill("Synthetic uploaded enclosure image");
  const path = `**/projects/${project.id}/revisions/${project.revision}/presentation`;
  await page.route(path, async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 409, contentType: "application/json", json: { error: { code: "conflict", message: "The image selection changed. Review it before saving." } } });
    else await route.continue();
  });
  await editor.getByRole("button", { name: "Save project image", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("The image selection changed");
  await expect(editor.getByLabel("Image description", { exact: true })).toHaveValue("Synthetic uploaded enclosure image");
  await expect(editor.getByRole("combobox", { name: "Image represents", exact: true })).toHaveValue("built_photo");
  await expectDecodedImage(editor.getByRole("img", { name: "Synthetic uploaded enclosure image", exact: true }));
  await page.unroute(path);
  await editor.getByRole("button", { name: "Save project image", exact: true }).click();
  await expect(editor).toContainText("Project image saved.");
  await expect(editor).toContainText("Built-product photo · uploaded-project-image.png");
});

async function uploadBuildFile(request: APIRequestContext, projectId: string, scope: { projectRevisionId: string } | { workItemId: string; workItemRevisionId: string }, filename: string, role: string, mediaType: string, bytes: Buffer) {
  const headers = { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const begin = await request.post(`${origin}/api/v1/artifacts/uploads`, { headers, data: { projectId, ...scope, filename, role, mediaType, byteSize: bytes.length, sha256 } });
  expect(begin.status(), await begin.text()).toBe(201);
  const session = (await begin.json()).data as { id: string };
  const write = await request.put(`${origin}/api/v1/artifacts/uploads/${session.id}`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, data: bytes });
  expect(write.status(), await write.text()).toBe(200);
  const finalize = await request.post(`${origin}/api/v1/artifacts/uploads/${session.id}/finalize`, { headers: { ...headers, "idempotency-key": randomUUID() }, data: {} });
  expect(finalize.status(), await finalize.text()).toBe(200);
  const file = (await finalize.json()).data as { id: string; sha256: string; version: number };
  expect(file.sha256).toBe(sha256);
  return file;
}

async function downloadedBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("MCP preparation opens a current-file build handoff from the project gallery", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const productImage = await syntheticProductImage(page);
  const project = await createProject(request, "Handoff MCP enclosure");
  const scope = { projectRevisionId: project.revision };
  const cover = await uploadImage(request, project, productImage);
  const print = await uploadBuildFile(request, project.id, scope, "enclosure-current.3mf", "three_mf", "application/vnd.ms-package.3dmanufacturing-3mf", printBytes);
  await uploadBuildFile(request, project.id, scope, "controller-current.kicad_pcb", "source", "application/x-kicad-pcb", Buffer.from("(kicad_pcb (version 20241229) (generator synthetic-fixture))\n"));
  await uploadBuildFile(request, project.id, scope, "assembly-current.md", "document", "text/markdown", Buffer.from("# Build the synthetic enclosure\nCheck dimensions and connections before assembly.\n"));
  const retired = await uploadBuildFile(request, project.id, scope, "retired-enclosure.3mf", "three_mf", "application/octet-stream", Buffer.from("Retained, retired print fixture"));
  const retirement = await request.delete(`${origin}/api/v1/artifacts/${retired.id}`, { headers: { authorization: `Bearer ${token}`, "if-match": String(retired.version), "idempotency-key": randomUUID() } });
  expect(retirement.status(), await retirement.text()).toBe(200);

  const work = await mcp<{ id: string }>(request, "create_work_item", { projectId: project.id, name: "Controller firmware", kind: "firmware" });
  const oldRevision = await mcp<{ id: string }>(request, "create_work_item_revision", { workItemId: work.id, summary: "Earlier workstream" });
  await uploadBuildFile(request, project.id, { workItemId: work.id, workItemRevisionId: oldRevision.id }, "historical-workstream.3mf", "three_mf", "application/octet-stream", Buffer.from("Historical workstream file"));
  const currentRevision = await mcp<{ id: string }>(request, "create_work_item_revision", { workItemId: work.id, summary: "Current controller" });
  await uploadBuildFile(request, project.id, { workItemId: work.id, workItemRevisionId: currentRevision.id }, "controller-current.uf2", "firmware", "application/octet-stream", Buffer.from("Synthetic current firmware"));
  await mcp(request, "save_project_presentation", { projectId: project.id, projectRevisionId: project.revision, presentation: { expectedVersion: 0, coverArtifactId: cover.id, imageKind: "render", caption: "Synthetic enclosure design render" } });
  await mcp(request, "save_build_plan", { projectId: project.id, projectRevisionId: project.revision, plan: { expectedVersion: 0, name: "Enclosure build handoff", parts: [{ id: "enclosure", name: "Enclosure", quantity: 1, artifactId: print.id }], plates: [{ id: "plate-one", name: "Enclosure plate", copies: 1, parts: [{ partId: "enclosure", quantity: 1 }], materials: [] }], notes: "Review the fit and slicer settings before making this design." } });

  const completed = await createProject(request, "Handoff MCP sensor box");
  const archived = await createProject(request, "Handoff MCP modular controller with removable cable channel");
  for (const [companion, description] of [
    [completed, "A small desk sensor enclosure concept."],
    [archived, "A modular enclosure concept with a removable cable channel. Confirm connector clearance, fastener fit and cable routing before preparing manufacturing files."],
  ] as const) {
    await mcp(request, "update_project", { projectId: companion.id, description });
    const image = await uploadImage(request, companion, productImage);
    await mcp(request, "save_project_presentation", { projectId: companion.id, projectRevisionId: companion.revision, presentation: { expectedVersion: 0, coverArtifactId: image.id, imageKind: "render", caption: `${companion.name} concept illustration` } });
  }
  await mcp(request, "update_project", { projectId: completed.id, status: "complete" });
  await mcp(request, "archive_project", { projectId: archived.id });

  await signIn(page);
  await page.getByRole("combobox", { name: "Filter projects", exact: true }).selectOption("all");
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill("Handoff MCP");
  const card = projectCard(page, project.name);
  await expectDecodedImage(card.getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
  await expect(card).toContainText("Design render");
  for (const companion of [completed, archived]) await expectDecodedImage(projectCard(page, companion.name).getByRole("img"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  await page.screenshot({ path: join(reviewDirectory, "project-gallery-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  await expectDecodedImage(card.getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(reviewDirectory, "project-gallery-phone.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const galleryDownload = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download enclosure-current.3mf", exact: true }).click();
  const galleryFile = await galleryDownload;
  expect(galleryFile.suggestedFilename()).toBe("enclosure-current.3mf");
  expect(await downloadedBytes(galleryFile)).toEqual(printBytes);
  const start = card.getByRole("button", { name: `Start build: ${project.name}`, exact: true });
  await start.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${origin}/#/projects/${project.id}/build`);
  const handoff = page.getByRole("region", { name: "Build handoff", exact: true });
  await expect(handoff.getByRole("heading", { name: "Start this build", exact: true })).toBeVisible();
  await expect(handoff).toContainText("Enclosure build handoff · version 1");
  await expect(handoff).toContainText("Enclosure plate: choose a printer before slicing.");
  await expect(handoff).toContainText("Enclosure plate: material estimates are not recorded.");
  for (const group of ["3D print", "PCB and fabrication", "Components and firmware", "Build instructions"]) await expect(handoff.getByRole("heading", { name: group, exact: true })).toBeVisible();
  await expect(handoff.getByRole("button", { name: "Download controller-current.uf2", exact: true })).toBeVisible();
  await expect(handoff).not.toContainText("historical-workstream.3mf");
  await expect(handoff).not.toContainText("retired-enclosure.3mf");

  const refreshedRevision = await mcp<{ id: string }>(request, "create_work_item_revision", { workItemId: work.id, summary: "Updated controller firmware" });
  await uploadBuildFile(request, project.id, { workItemId: work.id, workItemRevisionId: refreshedRevision.id }, "controller-refreshed.uf2", "firmware", "application/octet-stream", Buffer.from("Synthetic updated firmware"));
  await handoff.getByRole("button", { name: "Refresh build handoff", exact: true }).click();
  await expect(handoff.getByRole("button", { name: "Download controller-refreshed.uf2", exact: true })).toBeVisible();
  await expect(handoff.getByRole("button", { name: "Download controller-current.uf2", exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(reviewDirectory, "project-build-handoff-desktop.png"), fullPage: true });
  const handoffDownload = page.waitForEvent("download");
  await handoff.getByRole("button", { name: "Download enclosure-current.3mf", exact: true }).click();
  expect(await downloadedBytes(await handoffDownload)).toEqual(printBytes);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(reviewDirectory, "project-build-handoff-phone.png"), fullPage: true });

  let unexpectedDownloads = 0;
  page.on("download", () => { unexpectedDownloads += 1; });
  await page.route(`**/artifacts/${print.id}/download`, (route) => route.fulfill({ status: 200, body: "Synthetic corrupt response" }));
  await handoff.getByRole("button", { name: "Download enclosure-current.3mf", exact: true }).click();
  await expect(handoff.getByRole("alert").filter({ hasText: "integrity check" })).toBeVisible();
  expect(unexpectedDownloads).toBe(0);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: /^Projects/u }).click();
  await page.getByRole("combobox", { name: "Filter projects", exact: true }).selectOption("archived");
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill("Handoff MCP");
  await expect(projectCard(page, archived.name)).toBeVisible();
  await expect(card).toHaveCount(0);
  await projectCard(page, archived.name).getByRole("button", { name: `Open project ${archived.name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: archived.name, exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${origin}/#/projects/${archived.id}/plan`);
});
