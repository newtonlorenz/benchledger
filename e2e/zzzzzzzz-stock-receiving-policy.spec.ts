import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openProjectByName } from "./project-nav";

const demoPassword = "demo-password-please-change";
const projectName = "Synthetic receiving policy check";
const deliveredName = "Synthetic delivered M3 inserts";
const orderedName = "Synthetic ordered M3 screws";
// Screenshots for review go outside the checkout when requested.
const screenshotDir = process.env.BENCHLEDGER_E2E_SCREENSHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (screenshotDir === undefined) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill(demoPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Workspace overview" })).toBeVisible();
}

async function csrf(page: Page): Promise<string> {
  return (await page.context().cookies()).find((cookie) => cookie.name === "forge_csrf")!.value;
}

/** Seed a synthetic project whose requirements use delivered and ordered stock only. */
async function seed(page: Page): Promise<void> {
  const headers = { "x-csrf-token": await csrf(page) };
  for (const [id, name, state, kind] of [["e2e-policy-inserts", deliveredName, "delivered_uncounted", "fastener"], ["e2e-policy-screws", orderedName, "ordered_unverified", "fastener"]] as const) {
    const created = await page.request.post("/api/v1/inventory", { headers, data: { id, name, kind, quantity: 20, unit: "each", tags: [], links: [], evidence: { state, source: "synthetic e2e order" } } });
    expect(created.status()).toBe(201);
  }
  const project = await page.request.post("/api/v1/projects/with-initial-revision", { headers, data: { project: { id: "e2e-policy-project", name: projectName, status: "planned" }, revision: { id: "e2e-policy-revision", name: "Initial", status: "concept" } } });
  expect(project.status()).toBe(201);
  for (const [id, name, itemId] of [["e2e-policy-line-inserts", "Heat-set inserts", "e2e-policy-inserts"], ["e2e-policy-line-screws", "Mounting screws", "e2e-policy-screws"]] as const) {
    const line = await page.request.post("/api/v1/project-revisions/e2e-policy-revision/bom", { headers, data: { id, name, role: "consumed", itemId, requiredQuantity: 4, unit: "each", optional: false, alternatives: [], constraints: {} } });
    expect(line.status()).toBe(201);
  }
}

async function choosePolicy(page: Page, label: RegExp, expectedImpact: RegExp): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.locator(".stock-receiving-section");
  await expect(section.getByRole("heading", { name: "When does stock count as in stock?" })).toBeVisible();
  await section.getByRole("radio", { name: label }).check();
  await section.getByRole("button", { name: /Review change/u }).click();
  await expect(section.getByRole("group", { name: "Confirm stock setting change" })).toContainText(expectedImpact);
  await shot(page, `settings-review-${label.source.replace(/[^a-z]+/giu, "-").toLowerCase()}`);
  await section.getByRole("button", { name: "Save setting" }).click();
  await expect(section.getByRole("status")).toContainText("Saved.");
}

const row = (page: Page, name: string) => page.locator(".bom-row").filter({ hasText: name });

test("the receiving policy flips delivered stock from Check to ready without rewriting evidence", async ({ page }) => {
  await signIn(page);
  await seed(page);
  // The records were created through the API; reload so the browser reads them.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Workspace overview" })).toBeVisible();
  await openProjectByName(page, projectName);
  await expect(row(page, "Heat-set inserts")).toContainText("Check stock");
  await expect(row(page, "Mounting screws")).toContainText("Check stock");
  await shot(page, "bom-on-receipt");

  await choosePolicy(page, /When it's delivered/u, /\d+ items? will now count as in stock/u);
  await shot(page, "settings-saved-on-delivery");
  await openProjectByName(page, projectName);
  const inserts = row(page, "Heat-set inserts");
  await expect(inserts).toContainText("Ready to use");
  await expect(inserts).toContainText("Need 4 pieces · Have 4 pieces");
  await expect(inserts).toContainText("In stock · delivered, not counted");
  await expect(row(page, "Mounting screws")).toContainText("Check stock");
  await shot(page, "bom-on-delivery");

  // The inventory list and item drawer keep the recorded evidence visible.
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("textbox", { name: "Search inventory" }).fill("Synthetic delivered M3");
  const inventoryRow = page.locator("tr").filter({ hasText: deliveredName });
  await expect(inventoryRow).toContainText("In stock · delivered, not counted");
  await shot(page, "inventory-on-delivery");
  await page.getByRole("button", { name: `Open ${deliveredName}` }).click();
  const drawer = page.getByRole("dialog", { name: new RegExp(deliveredName, "u") });
  await expect(drawer).toContainText("In stock · delivered, not counted");
  await expect(drawer.getByText("Receive and count", { exact: true })).toBeVisible();
  await shot(page, "drawer-on-delivery");
  await drawer.getByRole("button", { name: "Close item details" }).click();

  // "When it's bought" also trusts the ordered screws.
  await choosePolicy(page, /When it's bought/u, /\d+ items? will now count as in stock/u);
  await openProjectByName(page, projectName);
  await expect(row(page, "Mounting screws")).toContainText("Ready to use");
  await expect(row(page, "Mounting screws")).toContainText("In stock · ordered, not yet delivered");

  // Restore the default so later runs and specs see the conservative policy.
  await choosePolicy(page, /When I've received and checked it/u, /\d+ items will no longer count as in stock/u);
  await openProjectByName(page, projectName);
  await expect(row(page, "Heat-set inserts")).toContainText("Check stock");
  const evidence = await (await page.request.get("/api/v1/inventory/e2e-policy-inserts")).json() as { evidence: { state: string }; availability: string };
  expect(evidence).toMatchObject({ evidence: { state: "delivered_uncounted" }, availability: "inspect_first" });
});
