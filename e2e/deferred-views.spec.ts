import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
}

test("optional viewers load on demand and a failed panel leaves the workspace usable", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", request => { if (request.resourceType() === "script") scripts.push(request.url()); });
  let unavailable = true;
  await page.route("**/assembly-ui-*.js", route => unavailable ? route.abort("failed") : route.continue());
  await page.route("**/assembly", route => route.fulfill({ json: { assembly: null, warnings: [] } }));
  await signIn(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inventory", exact: true })).toBeVisible();
  expect(scripts.filter(url => /\/(markdown-preview|assembly-ui|pcb-ui|assembly-canvas|stl-preview|OrbitControls)-/u.test(url))).toEqual([]);
  await page.getByRole("button", { name: /^Projects/u }).click();
  await page.getByRole("tab", { name: "Assembly", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Assembly explorer could not be opened.");
  await expect(page.getByRole("tab", { name: /^Plan/u })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#project-tabpanel").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "test-results/viewer-recovery-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText(/save any open work, then refresh/u).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/viewer-recovery-mobile.png" });
  await expect(page.getByRole("button", { name: "Retry assembly explorer" })).toHaveCount(0);
  await page.getByRole("tab", { name: "PCB", exact: true }).click();
  await expect(page.getByRole("heading", { name: "PCB viewer", exact: true })).toBeVisible();
  expect(scripts.some(url => /\/pcb-ui-/u.test(url))).toBe(true);
  expect(scripts.some(url => /\/(markdown-preview|assembly-canvas|stl-preview|OrbitControls)-/u.test(url))).toBe(false);
  unavailable = false;
  await page.getByRole("tab", { name: "Assembly", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "See how it fits together", exact: true })).toBeVisible();
});

test("a failed document preview retains its close action and keyboard boundary", async ({ page }) => {
  let unavailable = true;
  await page.route("**/markdown-preview-*.js", route => unavailable ? route.abort("failed") : route.continue());
  await signIn(page);
  await page.getByRole("button", { name: /^Projects/u }).click();
  await page.getByRole("tab", { name: /^Files/u }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "synthetic-recovery.md", mimeType: "text/markdown", buffer: Buffer.from("# Recovered document\n\nSynthetic local test.") });
  await page.getByRole("button", { name: "Add 1 file", exact: true }).click();
  const launcher = page.getByRole("button", { name: "Preview synthetic-recovery.md", exact: true });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "synthetic-recovery.md", exact: true });
  await expect(dialog.getByRole("alert")).toHaveText("Document preview could not be opened.");
  await expect(dialog.getByRole("button", { name: "Close preview" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(launcher).toBeFocused();
  await launcher.click(); await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByText(/save any open work, then refresh/u)).toBeVisible();
  await dialog.getByRole("button", { name: "Close preview" }).click();
  unavailable = false;
  await page.reload(); await launcher.click();
  await expect(dialog.getByRole("heading", { name: "Recovered document", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close preview" }).click();
});

test("a failed 3D module leaves assembly notes editable and protected", async ({ page }) => {
  await page.route("**/assembly-canvas-*.js", route => route.abort("failed"));
  await page.route("**/assembly", route => route.fulfill({ json: { assembly: null, warnings: [] } }));
  await signIn(page);
  await page.getByRole("button", { name: /^Projects/u }).click();
  await page.getByRole("tab", { name: /^Files/u }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "synthetic-viewer-failure.glb", mimeType: "model/gltf-binary", buffer: await readFile("docs/assets/showcase/synthetic-enclosure.glb") });
  await page.getByRole("button", { name: "Add 1 file", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download synthetic-viewer-failure.glb", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Assembly", exact: true }).click();
  await page.getByLabel("synthetic-viewer-failure.glb", { exact: true }).check();
  await page.getByRole("button", { name: "Open assembly", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("3D viewer could not be opened.");
  await page.getByRole("button", { name: "Edit assembly", exact: true }).click();
  await page.getByLabel("Assembly name", { exact: true }).fill("Draft with an unavailable viewer");
  await expect(page.getByRole("button", { name: "Save assembly", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: /^Files/u }).click();
  await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Assembly name", { exact: true })).toHaveValue("Draft with an unavailable viewer");
});
