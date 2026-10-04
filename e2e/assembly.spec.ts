import { openFileDetails, openProject, openProjectSection } from "./workspace-controls";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
test("assembly explorer imports CAD, edits a guide, saves and reopens on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/"); await page.getByLabel("Workspace password").fill("demo-password-please-change"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await openProject(page, "Synthetic H2D desk lamp"); await page.getByRole("tab", { name: /^Files/u }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "synthetic-assembly.step", mimeType: "model/step", buffer: await readFile("packages/artifacts/testfiles/synthetic-assembly.step") });
  await page.getByRole("button", { name: "Add 1 file", exact: true }).click(); await expect(page.getByRole("button", { name: "Download synthetic-assembly.step", exact: true })).toBeVisible();
  await openProjectSection(page, "Assembly");
  await page.getByLabel("synthetic-assembly.step", { exact: true }).check(); await page.getByRole("button", { name: "Open assembly", exact: true }).click();
  await expect(page.locator(".assembly-canvas canvas")).toBeVisible(); await expect(page.locator(".assembly-dimensions")).toContainText("40.0 × 30.0 × 17.0 mm");
  await page.getByRole("button", { name: "Exploded", exact: true }).click(); await expect(page.getByRole("slider", { name: "Assembly separation" })).toHaveAttribute("aria-valuenow", "100");
  await page.getByRole("button", { name: "Lid", exact: true }).click();
  await page.getByRole("button", { name: "Edit assembly", exact: true }).click();
  await page.getByLabel("Material", { exact: true }).fill("Synthetic cream PLA");
  await page.getByLabel("Fixing notes").fill("Seat the lid after checking the connector clearance.");
  // Losing GPU resources must not require navigation or discard this draft.
  await page.locator(".assembly-canvas canvas").evaluate(canvas => canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true })));
  await expect(page.getByRole("alert")).toContainText("graphics connection was lost");
  await expect(page.getByLabel("Fixing notes")).toHaveValue("Seat the lid after checking the connector clearance.");
  await page.getByRole("button", { name: "Retry 3D viewer", exact: true }).click();
  await expect(page.locator(".assembly-canvas canvas")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Fixing notes")).toHaveValue("Seat the lid after checking the connector clearance.");
  await page.getByRole("button", { name: "Placement and separation", exact: true }).click();
  await page.getByLabel("Separation (mm) Z", { exact: true }).fill("45");
  await page.getByRole("button", { name: "Isolate part", exact: true }).click(); await expect(page.getByLabel("Show Base", { exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Show all parts", exact: true }).click();
  // LAN HTTP does not expose randomUUID; both local identities must still work.
  await page.evaluate(() => Reflect.deleteProperty(Crypto.prototype, "randomUUID"));
  await page.getByRole("button", { name: "Lid", exact: true }).click();
  await page.getByRole("button", { name: "Add another placement", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Lid copy");
  await page.getByRole("button", { name: "Build order", exact: true }).click(); await page.getByRole("button", { name: "Add build step", exact: true }).click();
  await page.getByLabel("Step title").fill("Fit the enclosure"); await page.getByLabel("Instructions", { exact: true }).fill("Check both parts before fastening.");
  await page.getByRole("button", { name: "Save assembly", exact: true }).click(); await expect(page.getByText(/Saved version 1/u)).toBeVisible();
  await page.reload(); await expect(page.getByLabel("Build views").getByRole("button", { name: "Assembly", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".assembly-canvas canvas")).toBeVisible(); await page.getByRole("button", { name: "Lid", exact: true }).click(); await expect(page.getByText("Synthetic cream PLA", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Build order", exact: true }).click(); await page.getByRole("button", { name: /Fit the enclosure/u }).click();
  await expect(page.getByRole("slider", { name: "Assembly separation" })).toHaveAttribute("aria-valuenow", "55");
  await page.getByRole("button", { name: "Parts & details", exact: true }).click(); await page.getByRole("button", { name: "Show all", exact: true }).click(); await page.getByRole("button", { name: "Exploded", exact: true }).click();
  await page.screenshot({ path: "test-results/assembly-desktop.png", fullPage: true });
  const a11y = await new AxeBuilder({ page }).include(".assembly-workspace").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(a11y.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator(".assembly-canvas canvas")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/assembly-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Edit assembly", exact: true }).click(); await page.getByLabel("Assembly name", { exact: true }).fill("Unsaved assembly");
  await page.getByRole("tab", { name: /^Files/u }).click(); await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toBeVisible();
});

test("a large assembly keeps selection controls reachable in light, dark and narrow views", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/"); await page.getByLabel("Workspace password").fill("demo-password-please-change"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await openProject(page, "Synthetic H2D desk lamp"); await page.getByRole("tab", { name: /^Files/u }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "synthetic-panels.step", mimeType: "model/step", buffer: await readFile("packages/artifacts/testfiles/synthetic-assembly.step") });
  await page.getByRole("button", { name: "Add 1 file", exact: true }).click(); await expect(page.getByRole("button", { name: "Download synthetic-panels.step", exact: true })).toBeVisible();
  await page.route("**/assembly", route => route.request().method() === "GET" ? route.fulfill({ json: { assembly: null, warnings: [] } }) : route.abort());
  // Exercise a long list with synthetic repeated placements; never write the mocked draft.
  await page.route("**/assembly/inspect", async route => {
    const response = await route.fetch(), model = await response.json();
    model.parts = Array.from({ length: 26 }, (_, i) => ({ ...model.parts[0], id: `panel-${i}`, name: `Panel ${i + 1}`, position: [i % 5 * 45, Math.floor(i / 5) * 35, 0] }));
    await route.fulfill({ response, json: model });
  });
  await openProjectSection(page, "Assembly");
  await page.getByRole("button", { name: "Select all files", exact: true }).click(); await page.getByRole("button", { name: "Open assembly", exact: true }).click();
  await expect(page.locator(".assembly-canvas canvas")).toBeVisible();
  await expect(page.getByLabel("Assembly name", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save assembly", exact: true })).toBeVisible();
  const parts = page.getByRole("region", { name: "Model parts", exact: true });
  // A long list scrolls within its own region, leaving room for the selected
  // part's controls. The usable bound follows the layout, not an old pixel cap.
  expect(await parts.evaluate(element => element.scrollHeight > element.clientHeight && ["auto", "scroll"].includes(getComputedStyle(element).overflowY))).toBe(true);
  await expect(parts.getByRole("button", { name: "Panel 26", exact: true })).not.toBeInViewport();
  const selectLastPart = async () => {
    await page.getByLabel("Find a part", { exact: true }).fill("Panel 26");
    await parts.getByRole("button", { name: "Panel 26", exact: true }).click();
    await expect(page.getByRole("button", { name: "Isolate part", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Show all parts", exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByLabel("Find a part", { exact: true }).fill("");
    await expect(parts.getByRole("button", { name: "Panel 26", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Isolate part", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Show all parts", exact: true })).toBeInViewport({ ratio: 1 });
  };
  await selectLastPart();
  const stage = page.locator(".assembly-stage"); const light = await stage.evaluate(el => getComputedStyle(el).backgroundColor);
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await expect.poll(() => stage.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(light);
  const darkA11y = await new AxeBuilder({ page }).include(".assembly-workspace").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(darkA11y.violations).toEqual([]);
  await page.screenshot({ path: "test-results/assembly-large-dark.png", fullPage: true });
  await page.evaluate(() => document.documentElement.dataset.theme = "light");
  await page.setViewportSize({ width: 390, height: 844 });
  // ResizeObserver fits the WebGL canvas on the next layout pass.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("slider", { name: "Assembly separation" }).focus(); await page.keyboard.press("ArrowRight"); await expect(page.getByRole("slider", { name: "Assembly separation" })).toHaveAttribute("aria-valuenow", "1");
  await selectLastPart();
  await page.screenshot({ path: "test-results/assembly-large-mobile.png", fullPage: true });
});


test("the downloadable GLB showcase uploads with its standard browser media type", async ({ page }) => {
  await page.goto("/"); await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await openProject(page, "Synthetic H2D desk lamp"); await page.getByRole("tab", { name: /^Files/u }).click();
  const bytes = await readFile("docs/assets/showcase/synthetic-enclosure.glb");
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "synthetic-enclosure.glb", mimeType: "model/gltf-binary", buffer: bytes });
  await page.getByRole("button", { name: "Add 1 file", exact: true }).click();
  const details = await openFileDetails(page, "synthetic-enclosure.glb");
  const download = details.getByRole("button", { name: "Download file", exact: true });
  await expect(download).toBeVisible();
  const pending = page.waitForEvent("download"); await download.click();
  const stream = await (await pending).createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
});
