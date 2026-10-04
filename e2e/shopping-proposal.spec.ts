import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("canonical proposal copy and download include hidden selected quotes and unresolved requirements", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("Synthetic clipboard denial", "NotAllowedError")) } });
  });
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "forge_csrf")!.value;
  const headers = () => ({ "x-csrf-token": csrf, "idempotency-key": randomUUID() });
  const post = async (path: string, data: object) => {
    const response = await page.request.post(`/api/v1${path}`, { headers: headers(), data });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  };
  const id = `proposal-${randomUUID()}`, revision = `${id}-r1`;
  const root = `/projects/${id}/revisions/${revision}`;
  await post("/projects/with-initial-revision", { project: { id, name: "Synthetic complete shopping proposal", status: "planned" }, revision: { id: revision, name: "Initial", status: "concept", fabricationRoute: "none" } });
  const observedAt = new Date().toISOString();
  for (const fixture of [
    { name: "Proposal visible connectors", currency: "EUR", packageQuantity: 4, priceMinor: 250, shippingMinor: 100, taxIncluded: "yes" },
    { name: "Proposal hidden spacers", currency: "USD", packageQuantity: 3, priceMinor: 90, taxIncluded: "unknown" },
    { name: "Proposal unresolved bracket" }
  ]) {
    const line = await post(`/project-revisions/${revision}/bom`, { name: fixture.name, requiredQuantity: 7, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] });
    if (!fixture.currency) continue;
    const quote = await post(`${root}/requirement-offers`, { bomLineId: line.id, expectedBomLineVersion: line.version, supplier: `Synthetic ${fixture.currency} supplier`, title: `Recorded ${fixture.currency} package`, url: `https://supplier.example/${fixture.currency.toLowerCase()}`, packageQuantity: fixture.packageQuantity, packageUnit: "each", priceMinor: fixture.priceMinor, currency: fixture.currency, ...(fixture.shippingMinor === undefined ? {} : { shippingMinor: fixture.shippingMinor }), taxIncluded: fixture.taxIncluded, observedAt, validForDays: 30 });
    const chosen = await page.request.put(`/api/v1${root}/offer-choice`, { headers: headers(), data: { bomLineId: line.id, offerId: quote.id, expectedVersion: 0, expectedBomLineVersion: line.version, confirmedFit: true } });
    expect(chosen.ok(), await chosen.text()).toBe(true);
  }
  await page.goto(`/#/projects/${id}/offers`); await page.reload();
  await page.getByLabel("Search quote requirements").fill("Proposal visible connectors");
  await expect(page.locator(".sourcing-requirement")).toHaveCount(1);
  await expect(page.locator(".sourcing-requirement")).toContainText("Proposal visible connectors");
  await expect(page.locator(".sourcing-requirement")).not.toContainText("Proposal hidden spacers");
  const reads: URL[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/sourcing") && url.searchParams.get("limit") === "100") reads.push(url);
  });
  const copy = page.getByRole("button", { name: "Copy proposal", exact: true });
  await expect(copy).toBeEnabled(); await copy.click();
  const manual = page.getByRole("textbox", { name: "Shopping proposal text", exact: true });
  await expect(manual).toBeVisible(); await expect(manual).toBeFocused();
  await expect(page.getByText(/Clipboard access was unavailable/u)).toBeVisible();
  const copied = await manual.inputValue();
  const verify = (text: string) => {
    expect(text).toContain("3 requirements in the full revision");
    for (const name of ["Proposal visible connectors", "Proposal hidden spacers", "Proposal unresolved bracket"]) expect(text).toContain(name);
    expect(text).toContain("Recorded EUR package"); expect(text).toContain("Recorded USD package");
    expect(text).toContain("2 packs supply 8 each"); expect(text).toContain("3 packs supply 9 each");
    expect(text).toMatch(/6\.00 EUR/u); expect(text).toMatch(/2\.70 USD/u);
    expect(text).toContain("shipping incomplete"); expect(text).toContain("tax not fully confirmed");
    expect(text).toContain("https://supplier.example/eur"); expect(text).toContain("https://supplier.example/usd");
    expect(text).toContain(`Observed: ${observedAt}`); expect(text).toContain("No supplier observation selected.");
    expect(text).toContain("Nothing is purchased, reserved, received or physically confirmed");
  };
  verify(copied);
  expect(await manual.evaluate(element => { const field = element as HTMLTextAreaElement; return field.selectionStart === 0 && field.selectionEnd === field.value.length; })).toBe(true);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download proposal text", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^shopping-proposal-\d{4}-\d{2}-\d{2}\.txt$/u);
  const stream = await download.createReadStream(); expect(stream).not.toBeNull();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  verify(Buffer.concat(chunks).toString("utf8"));
  expect(reads).toHaveLength(4);
  expect(reads.every(url => url.searchParams.get("filter") === "all" && !url.searchParams.has("query"))).toBe(true);
  await expect(page.getByLabel("Search quote requirements")).toHaveValue("Proposal visible connectors");
  await expect(page.locator(".sourcing-requirement")).toHaveCount(1);
});
