import { expect, test } from "@playwright/test";

test("project files preview Markdown, images and STL and preserve download-only files", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: /^Projects/u }).click();
  await page.getByRole("tab", { name: /^Files/u }).click();
  const files = [
    { name: "preview-instructions.md", mimeType: "text/markdown", buffer: Buffer.from("# Assembly preview\n\n**Read first**\n\n<script>window.previewUnsafe = true</script>\n\n![remote](https://example.org/tracker)") },
    { name: "preview-drawing.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=", "base64") },
    { name: "preview-part.stl", mimeType: "model/stl", buffer: Buffer.from("solid part\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid part") },
    { name: "preview-source.step", mimeType: "model/step", buffer: Buffer.from("Synthetic download-only source") },
  ];
  await page.getByLabel("Choose files to upload").setInputFiles(files);
  await page.getByRole("button", { name: "Add 4 files", exact: true }).click();
  await expect(page.getByText("4 of 4 files uploaded", { exact: true })).toBeVisible();
  const markdownButton = page.getByRole("button", { name: "Preview preview-instructions.md", exact: true });
  await markdownButton.click();
  let dialog = page.getByRole("dialog", { name: "preview-instructions.md", exact: true });
  await expect(dialog.getByRole("heading", { name: "Assembly preview" })).toBeVisible();
  await expect(dialog.locator("strong")).toHaveText("Read first");
  await expect(dialog.locator("img, script")).toHaveCount(0);
  expect(await markdownButton.evaluate((element) => Boolean(element.closest("[inert]")))).toBe(true);
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
  await dialog.getByRole("button", { name: "Reset view" }).click();
  await dialog.getByRole("button", { name: "Close preview" }).click();
  await expect(page.getByRole("button", { name: "Preview preview-source.step", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download preview-source.step", exact: true })).toBeVisible();
  await page.route("**/artifacts/*/download", (route) => route.fulfill({ status: 200, body: "corrupted" }));
  await markdownButton.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("integrity check");
});
