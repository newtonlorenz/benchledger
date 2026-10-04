import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("project files preview safe content and preserve ZIP, SVG and JSON originals", async ({ page }) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.previewUnsafe=true"><script>window.previewUnsafe=true</script><image href="https://example.org/svg-preview-tracker"/></svg>';
  const evidence = JSON.stringify({ note: "<script>window.previewUnsafe=true</script>", passed: true });
  const requests: string[] = [];
  await page.route("https://example.org/svg-preview-tracker", (route) => { requests.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Switch to project Synthetic H2D desk lamp", exact: true }).click();
  await page.getByRole("tab", { name: /^Files/u }).click();
  const files = [
    { name: "preview-instructions.md", mimeType: "text/markdown", buffer: Buffer.from("# Assembly preview\n\n**Read first**\n\n<script>window.previewUnsafe = true</script>\n\n![remote](https://example.org/tracker)") },
    { name: "preview-drawing.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=", "base64") },
    { name: "preview-part.stl", mimeType: "model/stl", buffer: Buffer.from("solid part\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid part") },
    { name: "preview-source.step", mimeType: "model/step", buffer: Buffer.from("Synthetic download-only source") },
    { name: "preview-source.zip", mimeType: "application/zip", buffer: Buffer.from("504b0506000000000000000000000000000000000000", "hex") },
    { name: "preview-drawing.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) },
    { name: "preview-evidence.json", mimeType: "application/json", buffer: Buffer.from(evidence) },
  ];
  await page.getByLabel("Choose files to upload").setInputFiles(files);
  await page.getByRole("button", { name: "Add 7 files", exact: true }).click();
  await expect(page.getByText("7 of 7 files uploaded", { exact: true })).toBeVisible();
  const markdownButton = page.getByRole("button", { name: "Preview preview-instructions.md", exact: true });
  await markdownButton.click();
  let dialog = page.getByRole("dialog", { name: "preview-instructions.md", exact: true });
  await expect(dialog.getByRole("heading", { name: "Assembly preview" })).toBeVisible();
  await expect(dialog.locator("strong")).toHaveText("Read first");
  await expect(dialog.locator("img, script")).toHaveCount(0);
  expect(await page.locator('button[aria-label="Preview preview-instructions.md"]').evaluate((element) => Boolean(element.closest('[aria-hidden="true"]')))).toBe(true);
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(markdownButton).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Preview preview-drawing.png", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "preview-drawing.png", exact: true });
  const image = dialog.getByRole("img"); await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
  const bounds = await dialog.boundingBox(); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await dialog.getByRole("button", { name: "Close preview" }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Preview preview-part.stl", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "preview-part.stl", exact: true });
  await expect(dialog.getByRole("img", { name: "STL model preview" })).toBeVisible();
  await dialog.locator("canvas").evaluate(canvas => canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true })));
  await expect(dialog.getByRole("alert")).toContainText("graphics connection was lost");
  await dialog.getByRole("button", { name: "Retry STL preview", exact: true }).click();
  await expect(dialog.getByRole("img", { name: "STL model preview" })).toBeVisible();
  await dialog.getByRole("button", { name: "Reset view" }).click();
  await dialog.getByRole("button", { name: "Close preview" }).click();
  await expect(page.getByRole("button", { name: "Preview preview-source.step", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download preview-source.step", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview preview-source.zip", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download preview-source.zip", exact: true })).toBeVisible();
  for (const [name, source] of [["preview-drawing.svg", svg], ["preview-evidence.json", evidence]] as const) {
    const responsePromise = page.waitForResponse(response => /\/artifacts\/[^/]+\/download$/u.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: `Preview ${name}`, exact: true }).click();
    const response = await responsePromise;
    dialog = page.getByRole("dialog", { name, exact: true });
    await expect(dialog.locator("pre")).toHaveText(source);
    await expect(dialog.locator("svg, img, script, iframe, object, embed")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close preview" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Download ${name}`, exact: true })).toBeVisible();
    // Ordinary authenticated navigation must download too, without the UI's
    // fetch/blob path or a download attribute that could hide response-policy bugs.
    await page.evaluate(url => {
      const link = document.createElement("a");
      link.id = "direct-artifact-download";
      link.href = url;
      link.textContent = "Direct artifact download";
      Object.assign(link.style, { position: "fixed", top: "0", left: "400px", zIndex: "2147483647" });
      document.body.append(link);
    }, response.url());
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Direct artifact download", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(name);
    expect(await readFile((await download.path())!)).toEqual(Buffer.from(source));
    await page.locator("#direct-artifact-download").evaluate(element => element.remove());
  }
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, "previewUnsafe"))).toBeUndefined();
  await page.route("**/artifacts/*/download", (route) => route.fulfill({ status: 200, body: "corrupted" }));
  await markdownButton.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("integrity check");
});
