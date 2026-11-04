import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const out = new URL("../extension/icons/", import.meta.url);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b6cff"/>
      <stop offset="1" stop-color="#ff4f8b"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/>
      <stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#g)"/>
  <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#shine)"/>
  <g fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round">
    <path d="M30 40 L60 64 L30 88 Z"/>
    <path d="M60 40 L90 64 L60 88 Z"/>
    <rect x="94" y="40" width="5" height="48" rx="2"/>
  </g>
</svg>`;

await writeFile(new URL("icon.svg", out), svg);

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}`);
  await page.screenshot({ path: new URL(`icon${size}.png`, out).pathname, omitBackground: true });
}
await browser.close();
console.log("icons ok");
