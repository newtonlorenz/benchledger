import { expect, test, type Page, type Response } from "@playwright/test";

const demoPassword = "demo-password-please-change";
const projectName = "E2E exact catalog build";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill(demoPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "What are you making?" })).toBeVisible();
}

function catalogResponse(kind: "filament" | "printer", query: string) {
  return (response: Response): boolean => {
    const url = new URL(response.url());
    return ( response.request().method() === "GET"
      && response.status() === 200
      && url.pathname.endsWith("/api/v1/catalog/products")
      && url.searchParams.get("kind") === kind
      && url.searchParams.get("q") === query );
  };
}

function mutationResponse(path: string) {
  return (response: Response): boolean => response.request().method() === "POST"
    && response.status() === 201
    && new URL(response.url()).pathname.endsWith(path);
}

async function addExactInventory(
  page: Page,
  category: "Printers" | "Filament",
  kind: "printer" | "filament",
  query: string,
  productName: RegExp,
  quantity: string,
): Promise<Response> {
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  const addDialog = page.getByRole("dialog", { name: "Add to inventory" });
  await addDialog.getByRole("combobox", { name: "What are you adding?", exact: true }).selectOption(kind); await expect( addDialog.getByRole("combobox", { name: /Category/u }) ).toHaveCount(0);
  await addDialog.getByRole("button", { name: "Continue", exact: true }).click();

  const productSearch = page.getByRole("combobox", {
    name: category === "Filament" ? "Exact filament product" : "Exact printer model",
  });
  const searchResponse = page.waitForResponse(catalogResponse(kind, query));
  await productSearch.fill(query);
  await searchResponse;

  const productOption = page.getByRole("option", { name: productName });
  await expect(productOption).toBeVisible();
  await productOption.click();

  await page.getByLabel(category === "Filament" ? "Current mass (g)" : "Owned units").fill(quantity);
  await page.getByLabel("Link state").selectOption("confirmed"); if (category === "Printers") await page.getByLabel("Setup date").fill("2026-09-04"); const createResponse = page.waitForResponse(mutationResponse("/api/v1/inventory/with-product-profile"));
  await page.getByRole("button", {
    name: category === "Filament" ? "Add filament spool" : "Add printer",
    exact: true,
  }).click();
  const response = await createResponse;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return response;
}

test("guides an exact catalog build from owned stock to an auditable setup snapshot", async ({ page }) => {
  test.info().annotations.push({
    type: "known-product-boundary",
    description: "The artifact upload UI has no setup picker; it implicitly binds the current revision's saved setup, which this journey verifies from the upload request.",
  });

  await signIn(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What do you have?" })).toBeVisible();

  const printerResponse = await addExactInventory(
    page,
    "Printers",
    "printer",
    "H2D",
    /Bambu Lab.*H2D/u,
    "2",
  );
  const printerBody = (await printerResponse.json()) as { data?: { item?: unknown; profile?: unknown }; };
  expect(printerBody.data).toMatchObject({
    item: { kind: "printer", categoryNodeId: "category-printers", quantity: 2 },
    profile: { catalogProductId: "catalog-printer-h2d", profileType: "printer_asset", linkState: "confirmed" },
  });
  expect(printerResponse.request().postDataJSON().item).toMatchObject({ kind: "printer", categoryNodeId: "category-printers" });
  expect(printerResponse.request().postDataJSON().profile).not.toHaveProperty("itemId");

  const filamentResponse = await addExactInventory(
    page,
    "Filament",
    "filament",
    "PETG HF",
    /Bambu Lab.*PETG.*Black/u,
    "777",
  );
  const filamentBody = (await filamentResponse.json()) as { data?: { item?: unknown; profile?: unknown }; };
  expect(filamentBody.data).toMatchObject({
    item: { kind: "filament", categoryNodeId: "category-filament", quantity: 777, unit: "gram" },
    profile: { catalogProductId: "catalog-filament-petg-hf", profileType: "filament_spool", linkState: "confirmed" },
  });
  expect(filamentResponse.request().postDataJSON().item).toMatchObject({ kind: "filament", categoryNodeId: "category-filament" });
  expect(filamentResponse.request().postDataJSON().profile).not.toHaveProperty("itemId");

  await page.getByRole("button", { name: /^Projects/u }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Project goal").fill("A small exact-catalog test enclosure for the maker workflow.");
  const projectResponse = page.waitForResponse(mutationResponse("/api/v1/projects/with-initial-revision"));
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const createdProjectResponse = await projectResponse;
  expect(createdProjectResponse.status()).toBe(201);
  const createdProjectBody = (await createdProjectResponse.json()) as { data?: { project?: { id?: string } }; };
  const createdProjectId = createdProjectBody.data?.project?.id;
  expect(createdProjectId).toEqual(expect.any(String));
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click(); await page .getByRole("button", { name: "Show technical details", exact: true }) .click(); await expect( page.getByRole("button", { name: "Hide technical details", exact: true }) ).toBeVisible(); await page.getByRole("button", { name: /^Projects/u }).click(); await page.getByRole("button", { name: "New revision", exact: true }).click();
  const revisionDialog = page.getByRole("dialog", { name: `New revision for ${projectName}` });
  await expect(revisionDialog).toBeVisible();
  await revisionDialog.getByLabel("Revision name").fill("Exact setup capture");

  await expect(revisionDialog.getByText("How will you build it?", { exact: true })).toBeVisible();
  await revisionDialog.getByRole("radio", { name: /^3D-print parts/u }).check();
  await expect(revisionDialog.getByText("Printer for this revision", { exact: true })).toBeVisible();
  await expect(revisionDialog.getByText("Filament (optional technical setup)", { exact: true })).toBeVisible();
  await expect(revisionDialog).not.toContainText("immutable snapshot");
  const printerPicker = revisionDialog.getByRole("combobox", { name: "Printer for this revision" });
  await printerPicker.click();
  const ownedPrinter = revisionDialog.getByRole("option").filter({ hasText: "H2D" }).filter({ hasText: "2 each" }).filter({ hasText: "Exact product confirmed" });
  await expect(ownedPrinter).toHaveCount(1);
  await ownedPrinter.click();

  const filamentPicker = revisionDialog.getByRole("combobox", { name: "Filament (optional technical setup)" });
  await filamentPicker.click();
  const ownedFilament = revisionDialog.getByRole("option").filter({ hasText: "PETG HF" }).filter({ hasText: "777 g" }).filter({ hasText: "Exact product confirmed" });
  await expect(ownedFilament).toHaveCount(1);
  await ownedFilament.click();

  await expect( revisionDialog.locator("summary").filter({ hasText: "Technical details" }) ).toBeVisible();
  await revisionDialog.getByLabel("Hotend side").fill("single nozzle");
  await revisionDialog.getByLabel("Nozzle diameter (mm)").fill("0.4");
  await revisionDialog.getByLabel("Nozzle material").fill("hardened steel");
  await revisionDialog.getByLabel("Build plate").fill("Textured PEI");
  await revisionDialog.getByLabel("Accessories").fill("AMS 2 Pro");
  await revisionDialog.getByLabel("Firmware").fill("01.08");
  await revisionDialog.getByRole("textbox", { name: "Slicer", exact: true }).fill("Bambu Studio");
  await revisionDialog.getByRole("textbox", { name: "Slicer version", exact: true }).fill("1.10.0");
  await revisionDialog.getByLabel("Profile").fill("0.20 mm Standard");
  await revisionDialog.getByLabel("Calibration state").fill("flow checked");
  await revisionDialog.getByLabel("Explicit unknowns").fill("first-layer coupon");

  const revisionResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return ( response.request().method() === "POST"
      && response.status() === 201
      && /\/api\/v1\/projects\/[^/]+\/revisions$/u.test(url.pathname) );
  });
  const snapshotResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return ( response.request().method() === "POST"
      && response.status() === 201
      && /\/api\/v1\/project-revisions\/[^/]+\/build-configurations$/u.test(url.pathname) );
  });
  await revisionDialog.getByRole("button", { name: "Create revision", exact: true }).click();
  const [createdRevisionResponse, createdSnapshotResponse] = await Promise.all([revisionResponse, snapshotResponse]);
  const createdRevisionBody = (await createdRevisionResponse.json()) as { data?: { id?: string; projectId?: string }; };
  const snapshotBody = (await createdSnapshotResponse.json()) as { data?: Record<string, unknown>; };
  const snapshot = snapshotBody.data;
  expect(createdRevisionBody.data?.id).toBeTruthy();
  expect(snapshot).toMatchObject({
    projectRevisionId: createdRevisionBody.data?.id,
    printerItemSnapshot: { catalogProductId: "catalog-printer-h2d", linkState: "confirmed" },
    filamentSelections: [{ catalogProductId: "catalog-filament-petg-hf", linkState: "confirmed" }],
    activeHotend: "single nozzle",
    nozzle: { diameterMm: 0.4, material: "hardened steel" },
    plate: "Textured PEI",
    slicer: { name: "Bambu Studio", version: "1.10.0" },
    explicitUnknowns: ["first-layer coupon"],
  });
  expect(snapshot?.id).toEqual(expect.any(String));
  expect(snapshot?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(snapshot?.projectId).toBeUndefined();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  const projectPicker = page.getByRole("combobox", { name: "Choose project" });
  await projectPicker.selectOption({ label: projectName });
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();

  const buildApproach = page.getByRole("region", { name: "Build approach" });
  await expect(buildApproach).toContainText("Bambu Lab H2D");
  await expect( page.getByRole("region", { name: "Build setup summary" }) ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect( page.getByRole("button", { name: "Hide technical details", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Projects/u }).click(); await projectPicker.selectOption({ label: projectName }); const expertSummary = page.getByRole("region", { name: "Build setup summary" }); await expect(expertSummary).toContainText( "Use Bambu Lab · H2D with Bambu Lab · PETG · PETG HF." );
  await expect(expertSummary).toContainText( "Print setup: 0.4 mm nozzle · hardened steel · Textured PEI." ); await expect(expertSummary).toContainText( "Software: Bambu Studio 1.10.0 0.20 mm Standard." ); await expect(expertSummary).toContainText("Calibration: flow checked."); await expect( expertSummary.getByText("Show IDs, versions, evidence & unknowns", { exact: true })).toBeVisible();
  await expertSummary .getByText("Show IDs, versions, evidence & unknowns", { exact: true }).click();
  await expect(expertSummary).toContainText("Revision ID");
  await expect(expertSummary).toContainText("Printer product");
  await expect(expertSummary).toContainText("Filament product");
  await expect(expertSummary).toContainText("confirmed · confirmed");
  await expect(expertSummary).toContainText("first-layer coupon");
  await expect( expertSummary .locator("code").filter({ hasText: /^[a-f0-9]{64}(?: · [a-f0-9]{64})?$/u })).toHaveCount(1);

  const snapshotId = typeof snapshot?.id === "string" ? snapshot.id : "";
  expect(snapshotId).not.toBe("");
  const readPersistedSnapshot = async () => page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/build-configurations/${encodeURIComponent(id)}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }, snapshotId);
  const persistedBeforeUpload = await readPersistedSnapshot();
  expect(persistedBeforeUpload.status).toBe(200);
  expect(persistedBeforeUpload.body).toMatchObject({
    id: snapshotId,
    contentSha256: snapshot?.contentSha256,
    projectRevisionId: snapshot?.projectRevisionId,
    printerItemSnapshot: snapshot?.printerItemSnapshot,
    filamentSelections: snapshot?.filamentSelections,
  });

  await page.getByRole("tab", { name: "Files 0", exact: true }).click();
  const beginUploadResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return ( response.request().method() === "POST"
      && response.status() === 201
      && url.pathname.endsWith("/api/v1/artifacts/uploads") );
  });
  const finalizeUploadResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return ( response.request().method() === "POST"
      && response.status() === 200
      && /\/api\/v1\/artifacts\/uploads\/[^/]+\/finalize$/u.test(url.pathname) );
  });
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await (await fileChooser).setFiles({
    name: "e2e-bound-setup.step",
    mimeType: "model/step",
    buffer: Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"),
  }); await page.getByRole("button", { name: "Add 1 file", exact: true }).click(); const [beginUpload, finalizeUpload] = await Promise.all([beginUploadResponse, finalizeUploadResponse]);
  const beginUploadBody = beginUpload.request().postDataJSON() as Record<string, unknown>;
  expect(beginUploadBody).toMatchObject({
    projectId: createdProjectId,
    projectRevisionId: snapshot?.projectRevisionId,
    filename: "e2e-bound-setup.step",
    buildConfigurationSnapshotId: snapshotId,
  });
  const finalizedUploadBody = (await finalizeUpload.json()) as { data?: Record<string, unknown>; };
  expect(finalizedUploadBody.data).toMatchObject({
    projectId: createdProjectId,
    revisionId: snapshot?.projectRevisionId,
    filename: "e2e-bound-setup.step",
  });
  await expect(page.getByRole("status").filter({ hasText: "1 of 1 file uploaded" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Files 1", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: /e2e-bound-setup\.step/u })).toBeVisible();

  const persistedAfterUpload = await readPersistedSnapshot();
  expect(persistedAfterUpload.status).toBe(200);
  expect(persistedAfterUpload.body).toMatchObject({
    id: snapshotId,
    contentSha256: persistedBeforeUpload.body.contentSha256,
    projectRevisionId: persistedBeforeUpload.body.projectRevisionId,
    printerItemSnapshot: persistedBeforeUpload.body.printerItemSnapshot,
    filamentSelections: persistedBeforeUpload.body.filamentSelections,
  });
});

test("keeps the starter catalog facet path accessible and honest at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  const selectionDialog = page.getByRole("dialog", { name: "Add to inventory" });
  const completeCatalog = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return ( response.request().method() === "GET"
      && response.status() === 200
      && url.pathname.endsWith("/api/v1/catalog/products")
      && url.searchParams.get("kind") === "filament"
      && url.searchParams.get("limit") === "100"
      && !url.searchParams.has("q") );
  });
  await selectionDialog.getByRole("combobox", { name: "What are you adding?", exact: true }).selectOption("filament");
  await expect( selectionDialog.getByRole("combobox", { name: /Category/u }) ).toHaveCount(0);
  await selectionDialog.getByRole("button", { name: "Continue", exact: true }).click();
  await completeCatalog;
  const addDialog = page.getByRole("dialog", { name: "Add filament" });

  await addDialog.getByLabel("Manufacturer / brand").selectOption({ label: "Bambu Lab" });
  await addDialog.getByLabel("Product line / material family").selectOption({ label: "PETG" });
  const materialSubtype = addDialog.getByLabel("Material subtype");
  if (await materialSubtype.locator("option").filter({ hasText: "HF" }).count()) {
    await materialSubtype.selectOption({ label: "HF" });
  }
  await addDialog.locator("#catalog-facet-filament-colour").selectOption({ label: "Black" });
  await addDialog.locator("#catalog-facet-filament-diameterMm").selectOption({ label: "1.75 mm" });
  await addDialog.locator("#catalog-facet-filament-netMassG").selectOption({ label: "1,000 g net" });

  await expect(addDialog.getByRole("listbox", { name: "Exact filament products" })).toContainText("PETG HF");
  await expect(addDialog).toContainText("Catalog entries describe products only");
  await expect(addDialog).not.toContainText(/(?:In stock|Available now|Owned product)/u);
  const dialogBox = await addDialog.boundingBox();
  expect(dialogBox?.width).toBeLessThanOrEqual(358);
});
