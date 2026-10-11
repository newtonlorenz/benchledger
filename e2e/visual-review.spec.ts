import { expect, test } from "@playwright/test";
import { contactSheet } from "./visual-review";

test("contact sheets identify a blank frame and visible geometry and dispose their page", async ({ page, context }) => {
  const images = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 100; canvas.height = 100;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "#ffffff"; drawing.fillRect(0, 0, 100, 100);
    const blank = canvas.toDataURL("image/png").split(",")[1]!;
    drawing.fillStyle = "#006600"; drawing.fillRect(30, 30, 40, 40);
    return { blank, visible: canvas.toDataURL("image/png").split(",")[1]! };
  });
  const pagesBefore = context.pages().length;
  const sheet = await contactSheet(context, [
    { label: "Known blank control", png: Buffer.from(images.blank, "base64") },
    { label: "Known visible control", png: Buffer.from(images.visible, "base64") }
  ], "Synthetic pixel analysis controls");
  expect(context.pages()).toHaveLength(pagesBefore);
  expect(sheet.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(sheet.pixels).toEqual([
    { width: 100, height: 100, foregroundPixels: 0, foregroundRatio: 0 },
    { width: 100, height: 100, foregroundPixels: 1600, foregroundRatio: 0.16 }
  ]);
});
