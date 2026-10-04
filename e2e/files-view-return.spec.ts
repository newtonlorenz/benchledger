import { openBuildTool, clickProjectAction } from "./workspace-controls";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("Files keeps workstream scope and search across project tabs and resets for a new revision", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  const id = `files-return-${randomUUID()}`, revision = `${id}-r1`;
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "forge_csrf")!.value;
  const created = await page.request.post("/api/v1/projects/with-initial-revision", {
    headers: { "x-csrf-token": csrf, "idempotency-key": randomUUID() },
    data: { project: { id, name: "Synthetic file return", status: "planned", description: "Files return regression." }, revision: { id: revision, name: "Initial", status: "concept", fabricationRoute: "printed" } }
  });
  expect(created.status(), await created.text()).toBe(201);
  await page.goto(`/#/projects/${id}/build`); await page.reload();
  await openBuildTool(page, "tasks"); await page.getByRole("button", { name: "Add task group", exact: true }).click();
  await page.getByLabel("Task group name").fill("Synthetic body");
  await page.getByRole("button", { name: "Create task group", exact: true }).click();
  await expect(page.getByText("Task group created.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^Files/u }).click();
  const scope = page.getByLabel("Choose file scope");
  const workstreamScope = await scope.locator("option").filter({ hasText: "Synthetic body" }).getAttribute("value");
  expect(workstreamScope).toMatch(/^work-item:/u);
  await scope.selectOption(workstreamScope!);
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "synthetic-body.step", mimeType: "model/step", buffer: Buffer.from("Synthetic file view fixture") });
  await page.getByRole("button", { name: "Add 1 file", exact: true }).click();
  await expect(page.getByText("1 of 1 file uploaded", { exact: true })).toBeVisible();
  await page.getByLabel("Search project files").fill("body");
  for (const destination of [/^Parts/u, /^Build/u]) {
    await page.getByRole("tab", { name: destination }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.getByRole("tab", { name: /^Files/u }).click();
    await expect(scope).toHaveValue(workstreamScope!);
    await expect(page.getByLabel("Search project files")).toHaveValue("body");
    await expect(page.getByRole("button", { name: "Download synthetic-body.step", exact: true })).toBeVisible();
  }
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "staged.step", mimeType: "model/step", buffer: Buffer.from("Not uploaded") });
  await page.getByRole("tab", { name: /^Parts/u }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add 1 file", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: /^Parts/u }).click();
  await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
  await page.getByRole("tab", { name: /^Files/u }).click();
  await expect(scope).toHaveValue(workstreamScope!);
  await expect(page.getByRole("button", { name: "Add 1 file", exact: true })).toHaveCount(0);
  await clickProjectAction(page, "New revision");
  const dialog = page.getByRole("dialog", { name: "New revision for Synthetic file return", exact: true });
  await dialog.getByLabel("Revision name", { exact: true }).fill("Next fit");
  await dialog.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("tab", { name: /^Files/u }).click();
  await expect(scope).toHaveValue(/^project:/u);
  await expect(scope).not.toHaveValue(`project:${revision}`);
  await scope.selectOption("all");
  await expect(page.getByLabel("Search project files")).toHaveValue("");
});
