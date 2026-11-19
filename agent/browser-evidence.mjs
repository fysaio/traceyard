/* global document, Image */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const viewport = { width: 1280, height: 800 };

export async function browserEvidence(browser, directory, baseline, candidate) {
  await mkdir(directory, { recursive: true });
  if (baseline) await writeFile(join(directory, "baseline.png"), baseline);
  if (candidate) await writeFile(join(directory, "candidate.png"), candidate);
  if (!baseline || !candidate) return;
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    const result = await page.evaluate(
      async ({ before, after, viewport }) => {
        const { width, height } = viewport;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const pixels = async (png) => {
          const image = new Image();
          image.src = "data:image/png;base64," + png;
          await image.decode();
          ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, width, height);
        };
        const left = await pixels(before);
        const right = await pixels(after);
        let changedPixels = 0;
        for (let i = 0; i < right.data.length; i += 4) {
          const change = Math.max(
            Math.abs(right.data[i] - left.data[i]),
            Math.abs(right.data[i + 1] - left.data[i + 1]),
            Math.abs(right.data[i + 2] - left.data[i + 2]),
          );
          if (change <= 16) {
            right.data[i] = (right.data[i] + 255 * 3) / 4;
            right.data[i + 1] = (right.data[i + 1] + 255 * 3) / 4;
            right.data[i + 2] = (right.data[i + 2] + 255 * 3) / 4;
          } else {
            changedPixels++;
            right.data.set([190, 25, 66, 255], i);
          }
        }
        ctx.putImageData(right, 0, 0);
        return { changedPixels, diff: canvas.toDataURL().split(",")[1] };
      },
      { before: baseline.toString("base64"), after: candidate.toString("base64"), viewport },
    );
    await writeFile(join(directory, "diff.png"), Buffer.from(result.diff, "base64"));
    return { changedPixels: result.changedPixels, totalPixels: viewport.width * viewport.height };
  } finally {
    await context.close();
  }
}
