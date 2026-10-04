import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openProject } from "./workspace-controls";

for (const height of [844, 600]) test(`failed part save keeps its explanation and retry visible at 390x${height}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

  const id = `synthetic-recovery-${randomUUID()}`;
  const revisionId = `${id}-r1`;
  const name = `Synthetic recovery project ${height}`;
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "forge_csrf")!.value;
  const created = await page.request.post("/api/v1/projects/with-initial-revision", {
    headers: { "x-csrf-token": csrf, "idempotency-key": randomUUID() },
    data: { project: { id, name, status: "planned" }, revision: { id: revisionId, name: "Initial", status: "concept", fabricationRoute: "none" } },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.reload();
  await openProject(page, name, "Parts");
  await page.getByRole("button", { name: "Add first part", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a part", exact: true });
  const partName = "Synthetic panel mounting clips";
  const note = "Check clip width against the panel before sourcing.";
  await dialog.getByLabel("Part name", { exact: true }).fill(partName);
  await dialog.getByLabel("Amount needed", { exact: true }).fill("4");
  await dialog.getByRole("textbox", { name: "Specification (optional)", exact: true }).fill(note);
  await dialog.getByRole("button", { name: "Alternatives and notes", exact: true }).click();
  await dialog.getByLabel("How will you use it?", { exact: true }).selectOption("reusable");
  await dialog.getByRole("checkbox", { name: "Mark as optional", exact: true }).check();
  const attempts: unknown[] = [];
  await page.route(`**/api/v1/project-revisions/${revisionId}/bom`, route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: { code: "version_conflict", message: "The project changed. Your part has not been saved." } } });
  });
  await dialog.getByRole("button", { name: "Add part", exact: true }).click();
  const alert = dialog.getByRole("alert");
  const retry = dialog.getByRole("button", { name: "Try saving again", exact: true });
  await expect(alert).toContainText("Couldn’t save. Your entries are kept.");
  await expect(alert).toContainText("The project changed. Your part has not been saved.");
  // These checks must run before any operation that might scroll the form.
  await expect(alert).toBeInViewport({ ratio: 1 });
  await expect(retry).toBeInViewport({ ratio: 1 });
  const geometry = await dialog.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const fields = element.querySelector(".add-part-fields")!.getBoundingClientRect();
    const recovery = element.querySelector(".add-part-recovery")!.getBoundingClientRect();
    const error = element.querySelector('[role="alert"]')!;
    return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, fieldsBottom: fields.bottom, recoveryTop: recovery.top,
      errorFits: error.scrollHeight <= error.clientHeight + 1 && error.scrollWidth <= error.clientWidth + 1,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(geometry).toMatchObject({ errorFits: true, horizontalOverflow: false });
  expect(geometry.x).toBeGreaterThanOrEqual(0);
  expect(geometry.y).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(390);
  expect(geometry.bottom).toBeLessThanOrEqual(height);
  expect(geometry.fieldsBottom).toBeLessThanOrEqual(geometry.recoveryTop);
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`add-part-recovery-390x${height}.png`), animations: "disabled" });
  await expect(dialog.getByLabel("Part name", { exact: true })).toHaveValue(partName);
  await expect(dialog.getByLabel("Amount needed", { exact: true })).toHaveValue("4");
  await expect(dialog.getByLabel("Unit", { exact: true })).toHaveValue("each");
  await expect(dialog.getByRole("textbox", { name: "Specification (optional)", exact: true })).toHaveValue(note);
  await expect(dialog.getByLabel("How will you use it?", { exact: true })).toHaveValue("reusable");
  await expect(dialog.getByRole("checkbox", { name: "Mark as optional", exact: true })).toBeChecked();
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await retry.click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]).toEqual(attempts[0]);
  const lines = await page.request.get(`/api/v1/project-revisions/${revisionId}/bom`);
  expect(lines.ok()).toBe(true);
  expect(await lines.json()).toEqual([]);
});
