import type { BrowserContext } from "@playwright/test";

export interface ReviewFrame { label: string; png: Buffer }
export interface ReviewPixels { width: number; height: number; foregroundPixels: number; foregroundRatio: number }

/** Tile captured PNGs in an isolated, disposable page; never change the app page. */
export async function contactSheet(context: BrowserContext, frames: ReviewFrame[], title: string) {
  if (!frames.length || frames.length > 60) throw new Error("A contact sheet needs between 1 and 60 frames.");
  const page = await context.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    const result = await page.evaluate(async ({ frames, title }) => {
      const columns = Math.min(3, frames.length), tileWidth = 420, tileHeight = 348, heading = 48;
      const canvas = document.createElement("canvas");
      canvas.width = columns * tileWidth; canvas.height = heading + Math.ceil(frames.length / columns) * tileHeight;
      const drawing = canvas.getContext("2d");
      if (!drawing) throw new Error("Contact sheet requires a 2D canvas.");
      drawing.fillStyle = "#f3f3ef"; drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = "#202620"; drawing.font = "bold 19px sans-serif"; drawing.fillText(title, 14, 30);
      const pixels: ReviewPixels[] = [];
      for (const [index, frame] of frames.entries()) {
        const image = new Image(); image.src = frame.src; await image.decode();
        const sample = document.createElement("canvas"); sample.width = image.width; sample.height = image.height;
        const sampleDrawing = sample.getContext("2d");
        if (!sampleDrawing) throw new Error("Frame analysis requires a 2D canvas.");
        sampleDrawing.drawImage(image, 0, 0);
        const { data } = sampleDrawing.getImageData(0, 0, image.width, image.height);
        // The model canvas clears to a flat colour. Compare every pixel with its
        // corner background, allowing antialiasing and small colour differences.
        let foregroundPixels = 0;
        for (let offset = 0; offset < data.length; offset += 4) {
          if (Math.max(Math.abs(data[offset]! - data[0]!), Math.abs(data[offset + 1]! - data[1]!), Math.abs(data[offset + 2]! - data[2]!)) > 18) foregroundPixels++;
        }
        pixels.push({ width: image.width, height: image.height, foregroundPixels, foregroundRatio: foregroundPixels / (image.width * image.height) });
        const x = index % columns * tileWidth, y = heading + Math.floor(index / columns) * tileHeight;
        drawing.fillStyle = "#202620"; drawing.font = "15px sans-serif"; drawing.fillText(frame.label, x + 12, y + 24, tileWidth - 24);
        const scale = Math.min((tileWidth - 24) / image.width, (tileHeight - 48) / image.height);
        drawing.drawImage(image, x + (tileWidth - image.width * scale) / 2, y + 36, image.width * scale, image.height * scale);
      }
      return { png: canvas.toDataURL("image/png").split(",")[1]!, pixels };
    }, { frames: frames.map(frame => ({ label: frame.label, src: `data:image/png;base64,${frame.png.toString("base64")}` })), title });
    return { png: Buffer.from(result.png, "base64"), pixels: result.pixels };
  } finally {
    await page.close();
  }
}
