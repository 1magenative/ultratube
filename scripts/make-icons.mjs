// Нарезает иконки расширения из исходников docs/brand/*.webp: убирает белый фон вокруг (заливкой от краёв,
// чтобы белая буква внутри осталась), обрезает по форме и масштабирует. 48/128 — из основной иконки,
// 16/32 — из упрощённой, она лучше читается на маленьких размерах.
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";

const brand = new URL("../docs/brand/", import.meta.url);
const out = new URL("../extension/icons/", import.meta.url);
const jobs = [
  { source: "icon-source.webp", sizes: [128, 48] },
  { source: "icon-simple-source.webp", sizes: [32, 16] },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { source, sizes } of jobs) {
  const dataUrl = `data:image/webp;base64,${(await readFile(new URL(source, brand))).toString("base64")}`;
  const results = await page.evaluate(async ({ dataUrl, sizes }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const { width: w, height: h } = img;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const minC = (i) => Math.min(px[i], px[i + 1], px[i + 2]);

    // Фон: светлые пиксели, связанные с краями картинки.
    const bg = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
    while (stack.length) {
      const p = stack.pop();
      if (bg[p] || minC(p * 4) < 225) continue;
      bg[p] = 1;
      const x = p % w;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (p >= w) stack.push(p - w);
      if (p < w * (h - 1)) stack.push(p + w);
    }

    // Край формы: смесь цвета с белым — восстанавливаем прозрачность и исходный цвет.
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      if (bg[p]) {
        px[i + 3] = 0;
        continue;
      }
      const x = p % w, y = (p / w) | 0;
      const nearBg = bg[p - 1] || bg[p + 1] || bg[p - w] || bg[p + w] || bg[p - 2] || bg[p + 2] || bg[p - 2 * w] || bg[p + 2 * w];
      if (nearBg) {
        const a = Math.min(1, Math.max(0, (255 - minC(i)) / 150));
        if (a < 0.02) {
          px[i + 3] = 0;
          continue;
        }
        for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, Math.max(0, (px[i + c] - (1 - a) * 255) / a));
        px[i + 3] = Math.round(a * 255);
      }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    ctx.putImageData(data, 0, 0);

    // Квадратная обрезка по форме с небольшим полем.
    const side = Math.max(x1 - x0, y1 - y0) + 1;
    const pad = Math.round(side * 0.03);
    const full = side + pad * 2;
    const square = new OffscreenCanvas(full, full);
    const left = x0 - pad - (side - (x1 - x0 + 1)) / 2;
    const top = y0 - pad - (side - (y1 - y0 + 1)) / 2;
    square.getContext("2d").drawImage(canvas, -left, -top);

    const results = {};
    for (const size of sizes) {
      // Уменьшаем ступенями по 2 — так края получаются чище, чем одним шагом.
      let current = square;
      while (current.width / 2 > size) {
        const half = new OffscreenCanvas(Math.round(current.width / 2), Math.round(current.height / 2));
        const hctx = half.getContext("2d");
        hctx.imageSmoothingQuality = "high";
        hctx.drawImage(current, 0, 0, half.width, half.height);
        current = half;
      }
      const final = new OffscreenCanvas(size, size);
      const fctx = final.getContext("2d");
      fctx.imageSmoothingQuality = "high";
      fctx.drawImage(current, 0, 0, size, size);
      const blob = await final.convertToBlob({ type: "image/png" });
      results[size] = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    }
    return results;
  }, { dataUrl, sizes });
  for (const [size, b64] of Object.entries(results)) {
    await writeFile(new URL(`icon${size}.png`, out), Buffer.from(b64, "base64"));
  }
}
await browser.close();
console.log("icons ok");
