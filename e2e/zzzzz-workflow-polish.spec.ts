import { expect, test, type Page } from "@playwright/test";
async function login(page: Page) { await page.goto("/"); await page.getByLabel("Workspace password").fill("demo-password-please-change"); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible(); }
async function nav(page: Page, name: string) { if ((page.viewportSize()?.width ?? 1440) < 801) await page.getByLabel("Open navigation", { exact: true }).click(); await page.getByLabel("Primary navigation", { exact: true }).getByRole("button", { name: name === "Projects" ? /^Projects/u : name, exact: name !== "Projects" }).click(); }
async function create(page: Page, name: string) { await page.getByRole("button", { name: "New project", exact: true }).click(); await page.getByLabel("Project name", { exact: true }).fill(name); await page.getByLabel("Project goal", { exact: true }).fill("Synthetic workflow acceptance."); await page.getByRole("button", { name: "Create project", exact: true }).click(); await expect(page.getByRole("heading", { name, exact: true })).toBeVisible(); }
for (const width of [1440, 1024, 320]) test(`home supports finding, pinning and resuming projects at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await login(page);
  const name = `Polish sensor ${width}`; await create(page, name); await nav(page, "Workbench");
  await page.getByLabel("Find a project").fill(name); await expect(page.locator(".home-project-row")).toHaveCount(1);
  await page.getByRole("button", { name: `Pin project ${name}`, exact: true }).click(); await page.reload();
  await page.getByRole("group", { name: "Filter projects" }).getByRole("button", { name: /^Pinned/u }).click(); await expect(page.locator(".home-project-row")).toHaveCount(1);
  await page.getByRole("button", { name: `Open project ${name}`, exact: true }).click(); await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await nav(page, "Workbench"); await expect(page.getByRole("region", { name: "Resume recent project" })).toContainText(name);
  await page.getByRole("button", { name: "Resume project", exact: true }).click(); await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await nav(page, "Workbench"); await page.getByLabel("Find a project").fill("not-a-project"); await expect(page.getByText("No projects match this view", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show all projects", exact: true }).click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("home attention opens the selected stock check and leaves archive view", async ({ page }) => {
  await login(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "forge_csrf")?.value;
  expect(csrf).toBeTruthy();
  const seeded = await page.request.post("/api/v1/inventory", { headers: { "X-CSRF-Token": csrf! }, data: { name: "Polish uncertain connector", kind: "electronic", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "delivered_uncounted" } } });
  expect(seeded.status()).toBe(201); await page.reload(); await create(page, "Polish check pointer");
  await page.locator(".bom-section").getByRole("button", { name: "Add first requirement", exact: true }).click();
  await page.getByLabel("What do you need?", { exact: true }).fill("Check connector");
  const picker = page.getByLabel("Choose matching inventory", { exact: true });
  const item = await picker.locator("option").filter({ hasText: "Polish uncertain connector" }).getAttribute("value"); await picker.selectOption(item!);
  await page.getByRole("button", { name: "Add requirement", exact: true }).click();
  await page.getByRole("button", { name: /^Archived \(/u }).click(); await nav(page, "Workbench");
  const queue = page.getByRole("region", { name: "Workspace attention queue" }); await queue.getByRole("button", { name: "Stock checks", exact: true }).click();
  await queue.getByRole("button", { name: "Check stock: Polish check pointer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Polish check pointer", exact: true })).toBeVisible();
  await expect(page.getByLabel("Filter project requirements")).toHaveValue("check");
  await expect(page.locator(".bom-row")).toHaveCount(1); await expect(page.locator(".bom-row")).toContainText("Check connector");
});
test("build planning is a direct route and import opens an isolated dialog", async ({ page }) => {
  await login(page); await create(page, "Polish build route");
  await page.getByRole("tab", { name: "Build planning", exact: true }).click(); await expect(page).toHaveURL(/\/build$/u);
  await expect(page.getByRole("heading", { name: "Parts and build plates", exact: true })).toBeVisible(); await page.reload();
  await expect(page.getByRole("tab", { name: "Build planning", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /^Plan/u }).click(); await page.getByRole("button", { name: "Import requirements from CSV", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Import requirements from CSV", exact: true })).toBeVisible(); await expect(page.locator(".app-background")).toHaveAttribute("inert", ""); await expect(page.locator(".skip-link")).toHaveAttribute("inert", ""); await expect(page.getByLabel("Requirements CSV text", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav(page, "Workbench"); await page.getByRole("button", { name: "Import BOM", exact: true }).click(); await expect(page.getByRole("dialog", { name: "Guided project setup", exact: true })).toBeVisible();
});
test("supplier quote entry is visible before legacy offers", async ({ page }) => {
  await login(page); await create(page, "Polish supplier entry");
  await page.getByRole("button", { name: "Add first requirement", exact: true }).click(); await page.getByLabel("What do you need?", { exact: true }).fill("Polish bracket"); await page.getByRole("button", { name: "Add requirement", exact: true }).click();
  await page.getByRole("tab", { name: /^Shopping list/u }).click();
  await expect(page.getByRole("heading", { name: "Supplier quotes for this project", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Record quote for Polish bracket", exact: true }).click();
  await expect(page.getByLabel("Supplier", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Sourcing view" }).getByRole("button", { name: "All requirements", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel quote", exact: true }).click();
  await expect(page.locator(".historical-offers")).not.toHaveAttribute("open", "");
});
test("a dropped file needs explicit upload and the file list remains searchable", async ({ page }) => {
  await login(page); await create(page, "Polish file staging"); await page.getByRole("tab", { name: /^Files/u }).click();
  let uploads = 0; page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/artifacts")) uploads += 1; });
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(["synthetic fixture"], "café-fixture.txt", { type: "text/plain" })); return data; });
  await page.getByRole("group", { name: "File drop area" }).dispatchEvent("drop", { dataTransfer: transfer });
  expect(uploads).toBe(0); await page.getByRole("button", { name: "Add 1 file", exact: true }).click(); await expect(page.getByRole("button", { name: "Download café-fixture.txt", exact: true })).toBeVisible();
  await page.getByLabel("Search project files").fill("missing"); await expect(page.getByText("No matching files", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear file search", exact: true }).click(); await expect(page.getByRole("button", { name: "Download café-fixture.txt", exact: true })).toBeVisible(); await transfer.dispose();
});
