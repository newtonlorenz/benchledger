import { expect, test, type Page } from "@playwright/test";

async function startProject(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 801) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: /^Projects/u }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill(name);
  await page.getByLabel("Project goal", { exact: true }).fill("Synthetic maker workflow acceptance.");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Build approach", exact: true })).toHaveCount(1);
  await expect(page.locator(".dossier-column .build-approach-card")).toHaveCount(0);
}
async function addRequirement(page: Page, name: string) {
  await page.locator(".bom-section").getByRole("button", { name: /Add first requirement|Add a requirement/u }).click();
  await page.getByLabel("What do you need?", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add requirement", exact: true }).click();
}

for (const width of [1440, 320]) test(`maker can correct, remove, restore and hand off a project at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 850 });
  const name = `CX workshop ${width}`;
  await startProject(page, name);
  await addRequirement(page, "Enclosure screws");
  await page.getByRole("button", { name: "Edit requirement Enclosure screws", exact: true }).click();
  await page.getByLabel("Requirement name", { exact: true }).fill("M3 enclosure screws");
  await page.getByLabel("Required quantity", { exact: true }).fill("8");
  await page.getByLabel("Requirement note", { exact: true }).fill("Check length against the drawing.");
  await page.getByRole("button", { name: "Save requirement", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".bom-row").filter({ hasText: "M3 enclosure screws" })).toContainText("8 pieces");
  await page.getByRole("button", { name: "Edit requirement M3 enclosure screws", exact: true }).click();
  await page.getByRole("dialog").getByText("Remove requirement", { exact: true }).click();
  await page.getByLabel("I want to remove this requirement from the plan").check();
  await page.getByRole("button", { name: "Remove from plan", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".bom-row")).toHaveCount(0);
  await page.reload();
  await page.getByText("Removed requirements", { exact: true }).click();
  await page.getByRole("button", { name: "Restore requirement M3 enclosure screws", exact: true }).click();
  await expect(page.locator(".bom-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill(`${name} revised`);
  await page.getByLabel("Project goal and brief").fill("Build and test a reusable enclosure fixture.");
  await page.getByLabel("Project stage", { exact: true }).selectOption("building");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${name} revised`, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".project-stage")).toContainText("Building");
  await expect(page.locator(".bom-row")).toHaveCount(1);
  await page.getByText("Export project", { exact: true }).click();
  const jsonEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project brief JSON", exact: true }).click();
  const jsonDownload = await jsonEvent;
  const chunks: Buffer[] = []; for await (const chunk of (await jsonDownload.createReadStream())!) chunks.push(Buffer.from(chunk));
  const handoff = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(handoff.project).toMatchObject({ name: `${name} revised`, stage: "building" });
  expect(handoff.requirements).toHaveLength(1);
  expect(handoff.requirements[0]).toMatchObject({ name: "M3 enclosure screws", quantity: 8 });
  const csvEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download requirements CSV", exact: true }).click();
  const csvDownload = await csvEvent; expect(csvDownload.suggestedFilename()).toMatch(/\.csv$/u);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a committed requirement stays saved when readiness refresh fails", async ({ page }) => {
  await startProject(page, "CX committed create");
  let failGaps = false;
  await page.route("**/project-revisions/*/gaps", async (route) => {
    if (failGaps) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Synthetic refresh failure" } }) });
    else await route.continue();
  });
  failGaps = true;
  await addRequirement(page, "Saved despite refresh outage");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".bom-row").filter({ hasText: "Saved despite refresh outage" })).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("was saved");
  failGaps = false;
  await page.reload();
  await expect(page.locator(".bom-row").filter({ hasText: "Saved despite refresh outage" })).toHaveCount(1);
});

test("an unacknowledged create retries the same command without duplicating the requirement", async ({ page }) => {
  await startProject(page, "CX create retry");
  let first = true; const keys: string[] = [];
  await page.route("**/project-revisions/*/bom", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    keys.push(route.request().headers()["idempotency-key"]!);
    if (first) { first = false; await route.fetch(); await route.abort("failed"); }
    else await route.continue();
  });
  await addRequirement(page, "Exactly one support bracket");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("What do you need?", { exact: true })).toHaveValue("Exactly one support bracket");
  await page.getByRole("button", { name: "Add requirement", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  await page.reload();
  await expect(page.locator(".bom-row").filter({ hasText: "Exactly one support bracket" })).toHaveCount(1);
});

test("a rejected requirement correction preserves its draft", async ({ page }) => {
  await startProject(page, "CX correction conflict"); await addRequirement(page, "Prototype bracket");
  await page.getByRole("button", { name: "Edit requirement Prototype bracket", exact: true }).click();
  await page.getByLabel("Required quantity", { exact: true }).fill("12");
  await page.route("**/bom-lines/*", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "version_conflict", message: "Another editor changed this requirement. Reload before overwriting." } }) }));
  await page.getByRole("button", { name: "Save requirement", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Another editor");
  await expect(page.getByLabel("Required quantity", { exact: true })).toHaveValue("12");
});

test("an incomplete acknowledgement is not presented as a confirmed save", async ({ page }) => {
  await startProject(page, "CX malformed acknowledgement");
  let first = true; const keys: string[] = [];
  await page.route("**/project-revisions/*/bom", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    keys.push(route.request().headers()["idempotency-key"]!);
    if (first) {
      first = false; const response = await route.fetch(); const body = await response.json();
      await route.fulfill({ response, json: { ...body, data: { ...body.data, version: 0 } } });
    } else await route.continue();
  });
  await addRequirement(page, "Acknowledged only once");
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("did not confirm");
  await page.getByRole("button", { name: "Add requirement", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(keys[0]).toBe(keys[1]); await page.reload();
  await expect(page.locator(".bom-row").filter({ hasText: "Acknowledged only once" })).toHaveCount(1);
});

test("large project filters help find parts without changing readiness or the plan", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startProject(page, "CX larger project");
  for (const name of ["Stainless M3 screw", "Nylon M3 spacer", "Cable gland", "Rubber foot", "Steel washer", "Panel nut", "Plastic clip", "Board standoff"]) await addRequirement(page, name);
  await expect(page.locator(".bom-row")).toHaveCount(8);
  await expect(page.getByRole("tab", { name: /^Plan/u })).toContainText("8");
  await page.getByLabel("Search project requirements", { exact: true }).fill("M3 stainless");
  await expect(page.locator(".bom-row")).toHaveCount(1);
  await expect(page.locator(".bom-row")).toContainText("Stainless M3 screw");
  await expect(page.getByRole("tab", { name: /^Plan/u })).toContainText("8");
  await page.getByLabel("Filter project requirements", { exact: true }).selectOption("optional");
  await expect(page.locator(".bom-row")).toHaveCount(0);
  await expect(page.getByText("No requirements match these filters.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear requirement filters", exact: true }).click();
  await expect(page.locator(".bom-row")).toHaveCount(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await expect(page.locator(".bom-row")).toHaveCount(8);
});
