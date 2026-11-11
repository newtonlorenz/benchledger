import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { AssemblyInspection } from "@benchledger/api-contract";
import { openProject, openProjectSection } from "./workspace-controls";
import { contactSheet, type ReviewFrame, type ReviewPixels } from "./visual-review";

const views = ["Isometric", "Front", "Rear"] as const;
const separations = [0, 25, 50, 75, 100] as const;
const viewports = [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }] as const;

test("synthetic assembly review pack covers camera, separation, theme and viewport states", async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const fixture = await readFile("packages/artifacts/testfiles/synthetic-assembly.step");
  const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
  await page.setViewportSize(viewports[0]);
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await openProject(page, "Synthetic H2D desk lamp");
  // The signed-out demo session probe intentionally returns 401 before login.
  page.on("console", message => { if (message.type() === "error") pageErrors.push(`console.error: ${message.text()}`); });
  await page.getByRole("tab", { name: /^Files/u }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "synthetic-review.step", mimeType: "model/step", buffer: fixture });
  await page.getByRole("button", { name: "Add 1 file", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download synthetic-review.step", exact: true })).toBeVisible();
  await openProjectSection(page, "Assembly");
  await page.getByLabel("synthetic-review.step", { exact: true }).check();
  const inspecting = page.waitForResponse(response => response.url().endsWith("/assembly/inspect") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Open assembly", exact: true }).click();
  const response = await inspecting;
  expect(response.ok()).toBe(true);
  const inspection = await response.json() as AssemblyInspection;
  expect(inspection.sources).toHaveLength(1);
  expect(inspection.sources[0]!.sha256).toBe(fixtureSha256);
  expect(inspection.parts.map(part => part.name)).toEqual(["Base", "Lid"]);
  const identity = new URL(response.url()).pathname.match(/\/projects\/([^/]+)\/revisions\/([^/]+)\/assembly\/inspect$/u);
  expect(identity).not.toBeNull();
  const model = page.locator(".assembly-canvas canvas");
  const dimensions = page.locator(".assembly-dimensions");
  const toolbar = page.getByRole("group", { name: "Assembly views", exact: true });
  const slider = page.getByRole("slider", { name: "Assembly separation" });
  await expect(model).toBeVisible();
  await expect(dimensions).toContainText("40.0 × 30.0 × 17.0 mm");
  const assembledBounds = (await dimensions.textContent())!;
  const states: { theme: string; viewport: string; view: string; separation: number; sheet: string; frame: number; dimensions: string; pixels: ReviewPixels }[] = [];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const frames: ReviewFrame[] = [];
      const frameStates: Omit<typeof states[number], "pixels">[] = [];
      const filename = `assembly-${viewport.name}-${theme}.png`;
      for (const separation of separations) {
        // Exercise the public keyboard control, including the fit on key-up.
        await slider.focus(); await page.keyboard.press("Home");
        for (let value = 0; value < Math.floor(separation / 10); value++) await page.keyboard.press("PageUp");
        for (let value = 0; value < separation % 10; value++) await page.keyboard.press("ArrowRight");
        await expect(slider).toHaveAttribute("aria-valuenow", String(separation));
        for (const view of views) {
          await toolbar.getByRole("button", { name: view, exact: true }).click();
          for (const candidate of views) await expect(toolbar.getByRole("button", { name: candidate, exact: true })).toHaveAttribute("aria-pressed", String(candidate === view));
          await expect(slider).toHaveAttribute("aria-valuenow", String(separation));
          await expect(dimensions).toHaveText(assembledBounds);
          await expect(model).toBeVisible();
          await expect(page.locator(".assembly-render-error")).toHaveCount(0);
          // A screenshot waits for layout/paint; the canvas bounds must follow
          // the current viewport before capturing the WebGL result.
          await expect.poll(() => model.evaluate(canvas => Math.abs((canvas as HTMLCanvasElement).width / Math.min(devicePixelRatio, 2) - canvas.getBoundingClientRect().width))).toBeLessThan(2);
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
          expect(pageErrors, `${viewport.name}/${theme}/${view}/${separation}: unexpected page errors`).toEqual([]);
          // Centre the complete model canvas above the phone's fixed navigation
          // before capture, so UI overlays cannot masquerade as model pixels.
          await model.evaluate(canvas => canvas.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
          await expect.poll(() => model.evaluate(canvas => {
            const bounds = canvas.getBoundingClientRect();
            const navigation = document.querySelector('nav[aria-label="Workspace on phone"]');
            const navBounds = navigation?.getBoundingClientRect();
            const bottom = navBounds && navBounds.height > 0 ? navBounds.top : innerHeight;
            return bounds.top >= 0 && bounds.bottom <= bottom;
          })).toBe(true);
          frames.push({ label: `${view} · separation ${separation}% · ${viewport.width}px · ${theme}`, png: await model.screenshot() });
          frameStates.push({ theme, viewport: viewport.name, view, separation, sheet: filename, frame: frames.length - 1, dimensions: assembledBounds });
        }
      }
      const sheet = await contactSheet(context, frames, `Synthetic assembly · ${viewport.name} ${viewport.width}px · ${theme}`);
      const sheetPath = testInfo.outputPath(filename);
      await writeFile(sheetPath, sheet.png);
      await testInfo.attach(filename, { path: sheetPath, contentType: "image/png" });
      for (const [index, pixels] of sheet.pixels.entries()) {
        expect(pixels.foregroundRatio, `${frames[index]!.label}: model canvas must contain visible geometry`).toBeGreaterThan(0.005);
        states.push({ ...frameStates[index]!, pixels });
      }
    }
  }

  // Selection remains usable after the full camera/theme/resize matrix.
  await page.getByRole("button", { name: "Lid", exact: true }).click();
  await expect(page.getByRole("button", { name: "Lid", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Isolate part", exact: true }).click();
  await expect(page.getByLabel("Show Base", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Show Lid", { exact: true })).toBeChecked();
  await expect(dimensions).toHaveText(assembledBounds);
  await page.getByRole("button", { name: "Show all parts", exact: true }).click();
  await expect(page.getByLabel("Show Base", { exact: true })).toBeChecked();
  await expect(slider).toHaveAttribute("aria-valuenow", "100");
  expect(pageErrors).toEqual([]);
  expect(states).toHaveLength(60);
  const manifest = {
    schemaVersion: 1, synthetic: true, fixture: { name: "synthetic-assembly.step", sha256: fixtureSha256 },
    provenance: {
      projectId: decodeURIComponent(identity![1]!), projectRevisionId: decodeURIComponent(identity![2]!),
      assembly: { state: "unsaved inspected draft", persistedVersion: null, inspectionSha256: createHash("sha256").update(JSON.stringify(inspection)).digest("hex") },
      sources: inspection.sources, parts: inspection.parts.map(({ id, artifactId, nodeId, name }) => ({ id, artifactId, nodeId, name }))
    },
    assertions: ["separation preserved by camera choice", "exactly one camera pressed", "assembled dimensions stable", "model canvas nonblank", "no horizontal overflow", "selection and isolation restored", "no unexpected page errors or console errors"],
    states
  };
  const manifestPath = testInfo.outputPath("assembly-review-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await testInfo.attach("assembly-review-manifest", { path: manifestPath, contentType: "application/json" });
});
