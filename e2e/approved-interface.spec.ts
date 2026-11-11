import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { navigateWorkspace, openProject, openProjectSection } from "./workspace-controls";

async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dialog = page.getByRole("dialog");
  if (await dialog.count() === 1) {
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
  }
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false, animations: "disabled" });
}

for (const viewport of [{ width: 1536, height: 1024 }, { width: 390, height: 844 }]) {
  test(`approved interface keeps primary pages and forms usable at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await capture(page, info, "connection");
    await page.getByLabel("Workspace password").fill("demo-password-please-change");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Filters and view options", exact: true }).locator("svg").first()).toBeVisible();
    await capture(page, info, "projects");

    await page.getByRole("button", { name: "New project", exact: true }).click();
    await expect(page.getByLabel("Project name", { exact: true })).toBeVisible();
    if (viewport.width === 390) expect((await page.getByRole("dialog").boundingBox())!.width).toBe(viewport.width);
    await capture(page, info, "new-project");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

    await openProject(page, "Synthetic H2D desk lamp");
    await capture(page, info, "project-overview");
    const tabs = page.getByRole("tablist", { name: "Project workspace" });
    await expect(tabs.getByRole("tab")).toHaveText(["Overview", "Parts", "Files", "Build"]);
    const boxes = await tabs.getByRole("tab").evaluateAll(elements => elements.map(element => { const b = element.getBoundingClientRect(); return { top: b.top, left: b.left, right: b.right, height: b.height }; }));
    expect(new Set(boxes.map(box => Math.round(box.top))).size).toBe(1);
    for (const box of boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(viewport.width); if (viewport.width === 390) expect(box.height).toBeGreaterThanOrEqual(44); }

    await page.getByRole("button", { name: "Project actions", exact: true }).click();
    const actions = page.getByRole("dialog", { name: "Project actions", exact: true });
    await expect(actions.getByRole("button", { name: "New project", exact: true })).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
    await capture(page, info, "project-actions");
    await actions.getByRole("button", { name: "Close project actions", exact: true }).click();
    await openProjectSection(page, "Parts");
    await expect(page.locator(".bom-row").first()).toBeVisible();
    await capture(page, info, "project-parts");
    await page.getByRole("button", { name: "Add part", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add a part", exact: true });
    await expect(add.getByLabel("Part name", { exact: true })).toBeVisible();
    await expect(add.getByLabel("Part name", { exact: true })).toBeFocused();
    await expect(add.getByLabel("Amount needed", { exact: true })).toBeVisible();
    await expect(add.getByRole("button", { name: "Add part", exact: true })).toBeInViewport();
    await capture(page, info, "add-part");
    if (viewport.width === 390) {
      // A keyboard or a short landscape window leaves less vertical room.
      // The sheet must reflow, and its focused field and actions stay reachable.
      await page.setViewportSize({ width: 390, height: 420 });
      const name = add.getByLabel("Part name", { exact: true });
      await name.focus();
      await name.scrollIntoViewIfNeeded();
      await expect(name).toBeInViewport({ ratio: 1 });
      const save = add.getByRole("button", { name: "Add part", exact: true });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport({ ratio: 1 });
      await capture(page, info, "add-part-short-viewport");
      await page.setViewportSize(viewport);
    }
    await add.getByRole("button", { name: "Cancel", exact: true }).click();
    await openProjectSection(page, "Files");
    for (const name of ["3D print", "Electronics", "CAD & firmware", "Instructions"]) await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
    await capture(page, info, "project-files");
    await openProjectSection(page, "Build");
    await capture(page, info, "project-build");
    await navigateWorkspace(page, "Inventory");
    await expect(page.getByRole("textbox", { name: "Search inventory", exact: true })).toBeVisible();
    await expect(page.locator(".inventory-table tbody tr").first()).toBeVisible();
    await capture(page, info, "inventory");
    await navigateWorkspace(page, "Settings");
    await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
    await capture(page, info, "settings");
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    await capture(page, info, "settings-dark");
    await page.getByRole("radio", { name: "Light", exact: true }).click();
  });
}
