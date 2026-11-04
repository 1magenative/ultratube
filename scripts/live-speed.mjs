// Проверка скорости выше 2× на живом YouTube: кнопка «3,0» (Premium), ряд UltraTube, «−», Shift+> и Shift+<.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const SHOTS = new URL("../tests/screenshots/", import.meta.url);
const videoId = process.argv[2] ?? "XkELKJA4qpA";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 860 },
  locale: "ru-RU",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});
const page = await context.newPage();
await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: "domcontentloaded" });
const reject = page.getByText(/^(Отклонить все|Reject all)$/).first();
if (await reject.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false)) {
  await reject.click();
  await sleep(2500);
}
await page.waitForFunction(() => !document.querySelector("#movie_player")?.classList.contains("ad-showing"), null, { timeout: 60000 });
await sleep(1500);

const state = () => page.evaluate(() => {
  const p = document.querySelector("#movie_player");
  return {
    rate: p.querySelector("video").playbackRate,
    display: p.querySelector(".ytp-variable-speed-panel-display span")?.textContent,
    ourChips: p.querySelectorAll(".us-speed-chip").length,
    active: p.querySelector(".us-speed-chip.us-active")?.textContent ?? null,
    upsell: Boolean(document.querySelector("ytd-popup-container tp-yt-paper-dialog:not([aria-hidden='true']), yt-upsell-dialog-renderer, ytd-mealbar-promo-renderer")),
  };
});

await page.mouse.move(640, 300);
await page.click(".ytp-settings-button");
await page.locator(".ytp-settings-menu .ytp-menuitem", { hasText: /Скорость|Speed/ }).click();
await page.waitForSelector(".ytp-variable-speed-panel-content");
await sleep(500);
const log = { opened: await state() };
log.geometry = await page.evaluate(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height), e.getAttribute("style")?.slice(0, 80)]; };
  return { menu: r(".ytp-settings-menu"), content: r(".ytp-settings-menu .ytp-popup-content"), panel: r(".ytp-settings-menu .ytp-panel"), speed: r(".ytp-variable-speed-panel-content"), chips: r(".us-speed-chips"), player: r("#movie_player") };
});
console.log(JSON.stringify(log.geometry));

log.premiumChipVisible = await page.locator(".ytp-variable-speed-panel-preset-button", { has: page.locator(".ytp-variable-speed-panel-premium-upsell-icon") }).isVisible();
await page.locator(".us-speed-chip", { hasText: "3,0" }).click();
await sleep(600);
log.chip3 = await state();

await page.locator(".us-speed-chip", { hasText: "4,0" }).click();
await sleep(400);
log.chip4 = await state();

await page.locator(".ytp-variable-speed-panel-increment-button", { hasText: "-" }).click();
await sleep(400);
log.minus = await state();
await page.screenshot({ path: fileURLToPath(new URL("live-speed.png", SHOTS)), clip: { x: 0, y: 60, width: 900, height: 600 } });

await page.locator(".ytp-variable-speed-panel-preset-button", { hasText: "2,0" }).click();
await sleep(400);
log.backTo2 = await state();
await page.keyboard.press("Escape");
await sleep(300);
await page.keyboard.press("Shift+Period");
await sleep(300);
log.shiftUp = await state();
await page.keyboard.press("Shift+Comma");
await page.keyboard.press("Shift+Comma");
await sleep(300);
log.shiftDown = await state();
console.log(JSON.stringify(log));
await context.close();
