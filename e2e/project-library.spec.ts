import { navigateWorkspace } from "./workspace-controls";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, bearerRecord } from "../apps/server/dist/app.js";

const token = randomBytes(32).toString("hex");
let app: Awaited<ReturnType<typeof createApp>>;
let origin: string;

test.beforeAll(async () => {
  // Exercise the actual bearer and session boundaries on an isolated demo host.
  app = await createApp({ demo: true, logger: false, auth: { sessionSecret: randomBytes(48).toString("hex"), bearerTokens: [bearerRecord(token, ["read", "write"], undefined, "synthetic-image-agent")] } });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
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

async function createProject(request: APIRequestContext, name: string, description = "Synthetic maker project for the project-image regression.") {
  const id = `gallery-${randomUUID()}`, revision = `${id}-r1`;
  await mcp(request, "create_project_with_initial_revision", { name, projectId: id, revisionId: revision, description, revisionSummary: "Initial design", fabricationRoute: "printed" });
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

async function expectProjectImageEditor(page: Page) {
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Project image", exact: true })).toHaveAttribute("aria-expanded", "true");
  const editor = page.getByRole("region", { name: "Project image", exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

async function openProjectImageEditor(page: Page) {
  const disclosure = page.getByRole("button", { name: "Project image", exact: true });
  await expect(disclosure).toBeVisible();
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  return expectProjectImageEditor(page);
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

test("a chosen project render survives reload and stays visible in gallery and compact list", async ({ page, request }, testInfo) => {
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
  const editor = await expectProjectImageEditor(page);
  await expect(page.getByRole("button", { name: "Project image", exact: true })).toBeFocused();
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
  await openProjectImageEditor(page);
  await expect(editor).toContainText("Design render · synthetic-enclosure-render.png");
  await navigateWorkspace(page, "Projects");
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  await expectDecodedImage(card.getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
  await expect(card).toContainText("Design render");
  await page.screenshot({ path: join(tmpdir(), "benchledger-project-gallery-desktop.png"), fullPage: true });
  expect((await new AxeBuilder({ page }).include(".home-projects").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill("");
  await expectDecodedImage(card.getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
  await expect(page.locator(".project-gallery .product-image-placeholder").filter({ hasText: "Add a project image" }).first()).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
  await expect(card).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("approved-projects-gallery-1536.png"), fullPage: false, animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);

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
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 1536, height: 1024 });
  await expectDecodedImage(page.locator(".project-overview").getByRole("img", { name: "Synthetic enclosure design render", exact: true }));
  const nextAction = page.getByRole("region", { name: "Next project action", exact: true });
  await expect(nextAction.getByRole("heading", { name: "Add what this build needs", exact: true })).toBeVisible();
  await expect(nextAction.getByRole("button", { name: "Add first part", exact: true })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
  await expect(page.locator(".project-overview-image .product-image")).toBeInViewport({ ratio: 1 });
  await expect(nextAction).toBeInViewport({ ratio: 1 });
  for (const name of [/^Build files/u, /^Build plan/u]) await expect(page.locator(".project-continue").getByRole("button", { name })).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".project-overview-image img")).toHaveCSS("object-fit", "contain");
  await page.screenshot({ path: testInfo.outputPath("approved-project-overview-1536.png"), fullPage: false, animations: "disabled" });
});

test("project notes preserve long hashes and URLs without widening the phone overview", async ({ page, request }) => {
  const hash = "abcdef0123456789".repeat(4);
  const description = `Synthetic design notes.\nSHA-256 ${hash}\nhttps://example.invalid/designs/${hash}/assembly-reference`;
  const project = await createProject(request, "Gallery detailed notes", description);
  await signIn(page);
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(project.name);
  await projectCard(page, project.name).getByRole("button", { name: `Open project ${project.name}`, exact: true }).click();
  const notes = page.locator(".project-overview-notes > p");
  await expect(notes).toHaveText(description);
  for (const width of [390, 320, 1536]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await notes.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(notes).toHaveText(description);
  }
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
  await expect(card).toContainText("Add a project image");
  await expect(card.getByRole("img")).toHaveCount(0);
  await card.getByRole("button", { name: `Choose image for ${project.name}`, exact: true }).click();
  const editor = await expectProjectImageEditor(page);
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
  const editor = await expectProjectImageEditor(page);
  await editor.getByRole("button", { name: "Choose project image", exact: true }).click();
  await expect(editor).toContainText("Upload a PNG, JPEG or WebP in Files first");
  await editor.getByRole("button", { name: "Cancel image selection", exact: true }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "uploaded-project-image.png", mimeType: "image/png", buffer: bytes });
  await page.getByRole("button", { name: "Add 1 file", exact: true }).click();
  await expect(page.getByRole("button", { name: "Details for uploaded-project-image.png", exact: true })).toBeVisible();
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
