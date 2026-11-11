import { openPartStockMatch, openProjectSection, navigateWorkspace } from "./workspace-controls";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function signIn(page: Page) {
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

for (const width of [390, 1440]) {
  test(`an owned item returns to its requirement after ${width === 390 ? "creation" : "count"} retry and sign-in at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/"); await signIn(page);
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    const projectId = `owned-item-${randomUUID()}`, revisionId = `${projectId}-r1`;
    const name = `Synthetic first-use connector ${width}`;
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === "forge_csrf")!.value;
    const project = await page.request.post("/api/v1/projects/with-initial-revision", { headers: { "x-csrf-token": csrf, "idempotency-key": randomUUID() }, data: { project: { id: projectId, name: `Synthetic owned item project ${width}`, status: "planned", description: "Synthetic first-use inventory regression." }, revision: { id: revisionId, name: "Initial", status: "concept", fabricationRoute: "none" } } });
    expect(project.ok()).toBe(true);
    await page.goto(`/#/projects/${projectId}/plan`); await page.reload();
    await page.getByRole("button", { name: "Add first part", exact: true }).click();
    const requirement = page.getByRole("dialog", { name: "Add a part", exact: true });
    await requirement.getByLabel("Part name", { exact: true }).fill(name);
    await requirement.getByLabel("Amount needed", { exact: true }).fill("2");
    await requirement.getByLabel("Specification (optional)").fill("Check the connector polarity before use.");
    await openPartStockMatch(page);
    await requirement.getByRole("button", { name: "Add an owned item", exact: true }).click();
    await page.getByRole("dialog", { name: "Add to inventory", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(requirement.getByLabel("Amount needed", { exact: true })).toHaveValue("2");
    await expect(requirement.getByRole("button", { name: "Add part", exact: true })).toBeFocused();
    await expect(requirement.getByRole("button", { name: "Clear owned item selection", exact: true })).toHaveCount(0);
    await openPartStockMatch(page);
    await requirement.getByRole("button", { name: "Add an owned item", exact: true }).click();
    await page.getByRole("combobox", { name: "What are you adding?", exact: true }).selectOption("electronic");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const capture = page.getByRole("dialog", { name: "Add an inventory item", exact: true });
    await expect(capture.getByLabel("Name", { exact: true })).toHaveValue(name);
    await capture.getByRole("button", { name: "Specifications & identity", exact: true }).click();
    await capture.getByLabel("Details and specifications (optional)").fill("JST-PH, 2 pins, 2.0 mm pitch");
    await capture.getByLabel("Recorded quantity", { exact: true }).fill("5");
    await capture.getByRole("checkbox", { name: "I have counted these", exact: true }).check();
    const createWrites: Array<{ key: string | undefined; body: string | null }> = [];
    let itemId = "";
    await page.route(/\/api\/v1\/inventory$/u, async route => {
      createWrites.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (width === 390 && createWrites.length === 2) return route.fulfill({ status: 401, json: { error: { code: "unauthenticated", message: "Synthetic sign-in required." } } });
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const body = await response.json(); itemId = body.data.id;
      if (width === 390 && createWrites.length === 1) return route.abort("failed");
      return route.fulfill({ response });
    });
    const countWrites: Array<{ key: string | undefined; body: string | null }> = [];
    await page.route(/\/api\/v1\/inventory\/[^/]+\/count$/u, async route => {
      countWrites.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (width === 1440 && countWrites.length === 1) return route.abort("failed");
      if (width === 1440 && countWrites.length === 2) return route.fulfill({ status: 401, json: { error: { code: "unauthenticated", message: "Synthetic sign-in required." } } });
      return route.continue();
    });
    await capture.getByRole("button", { name: "Add item and review count", exact: true }).click();
    if (width === 390) {
      await expect(capture.getByRole("button", { name: "Retry unchanged item", exact: true })).toBeVisible();
      await expect(capture.getByLabel("Name", { exact: true })).toBeDisabled();
      await capture.getByRole("button", { name: "Retry unchanged item", exact: true }).click();
      await expect(page.getByLabel("Workspace password")).toBeVisible();
      await expect(page.locator("body")).not.toContainText(name);
      await signIn(page);
      await expect(capture.getByLabel("Recorded quantity", { exact: true })).toHaveValue("5");
      expect(createWrites).toHaveLength(2);
      await capture.getByRole("button", { name: "Retry unchanged item", exact: true }).click();
      expect(createWrites[1]).toEqual(createWrites[0]);
    }
    const review = page.getByRole("alertdialog", { name: "Review physical count", exact: true });
    await expect(review).toBeVisible();
    expect(countWrites).toHaveLength(0);
    const uncounted = await page.request.get(`/api/v1/inventory/${itemId}`);
    expect((await uncounted.json()).evidence.state).toBe("unknown");
    await review.getByRole("button", { name: "Confirm physical count", exact: true }).click();
    if (width === 1440) {
      await review.getByRole("button", { name: "Retry unchanged observation", exact: true }).click();
      await expect(page.getByLabel("Workspace password")).toBeVisible();
      await expect(page.locator("body")).not.toContainText(name);
      await signIn(page);
      await expect(review).toBeVisible();
      expect(countWrites).toHaveLength(2);
      await review.getByRole("button", { name: "Retry unchanged observation", exact: true }).click();
    }
    await expect(review).toHaveCount(0);
    const drawer = page.getByRole("dialog", { name: new RegExp(`^${name}`, "u") });
    await expect(drawer.getByText("Physical count saved", { exact: true })).toBeVisible();
    await expect(drawer.getByLabel("Counted quantity", { exact: true })).toHaveCount(0);
    expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await drawer.getByRole("button", { name: `Return to ${name}`, exact: true }).click();
    await expect(requirement.getByLabel("Part name", { exact: true })).toHaveValue(name);
    await expect(requirement.getByRole("button", { name: "Add part", exact: true })).toBeFocused();
    await expect(requirement.getByLabel("Amount needed", { exact: true })).toHaveValue("2");
    await expect(requirement.getByLabel("Unit", { exact: true })).toHaveValue("each");
    await expect(requirement.getByRole("button", { name: "Clear owned item selection", exact: true })).toBeVisible();
    await expect(requirement.getByLabel("Specification (optional)")).toHaveValue("Check the connector polarity before use.");
    await requirement.getByRole("button", { name: "Add part", exact: true }).click();
    await expect(requirement).toHaveCount(0);
    if (width === 390) {
      await page.getByRole("main").evaluate(element => { element.scrollTop = 0; });
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect.poll(() => page.getByRole("main").evaluate(element => element.scrollTop)).toBe(0);
      const requirementRow = page.locator(".bom-row").filter({ hasText: name });
      await expect(requirementRow).toBeVisible();
      await expect.poll(() => requirementRow.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= window.innerHeight; })).toBe(true);
    }
    const lines = await page.request.get(`/api/v1/project-revisions/${revisionId}/bom`);
    expect(lines.ok(), await lines.text()).toBe(true);
    const savedLines = await lines.json();
    expect(Array.isArray(savedLines)).toBe(true);
    const saved = savedLines.find((line: { name: string }) => line.name === name);
    expect(saved).toMatchObject({ itemId, requiredQuantity: 2, unit: "each", notes: "Check the connector polarity before use." });
    expect(createWrites).toHaveLength(width === 390 ? 3 : 1);
    expect(countWrites).toHaveLength(width === 1440 ? 3 : 1);
    for (const attempt of createWrites) expect(attempt).toEqual(createWrites[0]);
    for (const attempt of countWrites) expect(attempt).toEqual(countWrites[0]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("a just-created item removed elsewhere does not block reconnection", async ({ page }) => {
  await page.goto("/"); await signIn(page);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await navigateWorkspace(page, "Inventory");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByRole("combobox", { name: "What are you adding?", exact: true }).selectOption("electronic");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const name = `Synthetic removable item ${randomUUID()}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/inventory");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  const item = (await (await created).json()).data;
  const drawer = page.getByRole("dialog", { name: new RegExp(`^${name}`, "u") });
  await expect(drawer).toBeVisible();
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "forge_csrf")!.value;
  const removed = await page.request.delete(`/api/v1/inventory/${item.id}`, { headers: { "x-csrf-token": csrf, "if-match": String(item.version), "idempotency-key": randomUUID() } });
  expect(removed.ok()).toBe(true);
  let missingReads = 0;
  await page.route(`**/api/v1/inventory/${item.id}`, async route => {
    if (route.request().method() === "PATCH") return route.fulfill({ status: 401, json: { error: { code: "unauthenticated", message: "Synthetic sign-in required." } } });
    missingReads++;
    return route.continue();
  });
  await drawer.getByRole("button", { name: "Edit item", exact: true }).click();
  await drawer.getByLabel("Name", { exact: true }).fill(`${name} edited`);
  await drawer.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByLabel("Workspace password")).toBeVisible();
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Inventory", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Workspace password")).toHaveCount(0);
  expect(missingReads).toBe(1);
});


test("category recovery keeps nested drafts until one approved Settings navigation", async ({ page }) => {
  await page.route("**/api/v1/inventory/categories?**", route => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Synthetic category service unavailable." } } }));
  await page.goto("/"); await signIn(page);
  await page.getByRole("button", { name: "Open project Synthetic H2D desk lamp", exact: true }).click();
  await openProjectSection(page, "Parts");
  await page.getByRole("button", { name: "Add part", exact: true }).click();
  const requirement = page.getByRole("dialog", { name: "Add a part", exact: true });
  await requirement.getByLabel("Part name", { exact: true }).fill("Synthetic retained category-recovery connector");
  await requirement.getByLabel("Amount needed", { exact: true }).fill("3");
  await openPartStockMatch(page);
    await requirement.getByRole("button", { name: "Add an owned item", exact: true }).click();
  const capture = page.getByRole("dialog", { name: "Add to inventory", exact: true });
  await capture.getByRole("button", { name: "Open Settings", exact: true }).click();
  const guard = page.getByRole("alertdialog", { name: "Leave without saving?", exact: true });
  await guard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(capture).toBeVisible();
  await capture.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(requirement.getByLabel("Part name", { exact: true })).toHaveValue("Synthetic retained category-recovery connector");
  await expect(requirement.getByLabel("Amount needed", { exact: true })).toHaveValue("3");
  await openPartStockMatch(page);
    await requirement.getByRole("button", { name: "Add an owned item", exact: true }).click();
  await capture.getByRole("button", { name: "Open Settings", exact: true }).click();
  await guard.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("main")).toBeFocused();
  await navigateWorkspace(page, "Projects");
  await page.getByRole("button", { name: "Open project Synthetic H2D desk lamp", exact: true }).click();
  await openProjectSection(page, "Parts");
  await page.getByRole("button", { name: "Add part", exact: true }).click();
  await expect(requirement.getByLabel("Part name", { exact: true })).toHaveValue("");
  await expect(requirement.getByLabel("Amount needed", { exact: true })).toHaveValue("1");
});
