// Подсветка на живых YouTube и YouTube Music: включает её, открывает панель в плеере,
// проверяет полный экран, клип и трек без клипа (перелив и пульс) и снимает страницы (тёмная тема).
// node scripts/live-ambient.mjs [videoId] [audioTrackId]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const SHOTS = new URL("../tests/screenshots/", import.meta.url);
const videoId = process.argv[2] ?? "kJQP7kiw5Fk";
const trackId = process.argv[3] ?? "1IWsqTqAjeI";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(`live-ambient-${name}.png`, SHOTS)) });

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: !process.env.HEADED,
  viewport: { width: 1440, height: 900 },
  locale: "ru-RU",
  colorScheme: "dark",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
await sleep(500);
await worker.evaluate(async () => {
  const settings = US.merge((await chrome.storage.sync.get("settings")).settings);
  await chrome.storage.sync.set({ settings: { ...settings, ambient: true, ambientMusic: true } });
});

async function open(url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const reject = page.getByText(/^(Отклонить все|Reject all)$/).first();
  if (await reject.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false)) {
    await reject.click();
    await page.waitForURL(/youtube\.com\/(?!.*consent)/, { timeout: 15000 }).catch(() => {});
  }
  return page;
}

const state = (page) => page.evaluate(() => ({
  glow: Boolean(document.querySelector(".us-ambient.us-show")),
  fill: Boolean(document.querySelector(".us-ambient-fill.us-show")),
  header: Boolean(document.querySelector(".us-ambient-header.us-show")),
  host: document.querySelector(".us-ambient")?.parentElement?.tagName.toLowerCase() ?? null,
  button: Boolean(document.querySelector(".us-ambient-btn")),
  pulsing: Boolean(document.querySelector(".us-ambient.us-pulsing")),
  ad: document.querySelector("#movie_player")?.classList.contains("ad-showing") ?? null,
}));

async function waitGlow(page) {
  for (let i = 0; i < 40 && !(await state(page)).glow; i++) await sleep(1000);
  await sleep(1500);
}

// YouTube: обычный вид, панель, полный экран.
const yt = await open(`https://www.youtube.com/watch?v=${videoId}`);
await waitGlow(yt);
console.log("youtube", JSON.stringify(await state(yt)));
await yt.mouse.move(700, 400);
await yt.click(".us-ambient-btn");
await sleep(500);
await shot(yt, "youtube-panel");
await yt.keyboard.press("Escape");
await yt.mouse.click(1430, 890);
await yt.mouse.move(1430, 890);
await shot(yt, "youtube");
await yt.evaluate(() => document.querySelector("#movie_player").requestFullscreen?.());
await sleep(2500);
console.log("youtube fullscreen", JSON.stringify(await state(yt)));
await shot(yt, "youtube-fullscreen");
await yt.close();

// YouTube Music: клип (полосы вокруг видео) и трек без клипа (обложка, перелив и пульс).
const clip = await open(`https://music.youtube.com/watch?v=${videoId}`);
await waitGlow(clip);
console.log("music clip", JSON.stringify(await state(clip)));
await clip.mouse.move(1430, 600);
await shot(clip, "music-clip");
await clip.close();

const track = await open(`https://music.youtube.com/watch?v=${trackId}`);
await waitGlow(track);
await track.mouse.click(700, 32);
let peak = 0;
for (let i = 0; i < 60; i++) {
  peak = Math.max(peak, await track.evaluate(() => Number(document.querySelector(".us-ambient")?.style.getPropertyValue("--us-pulse")) || 0));
  await sleep(50);
}
console.log("music track", JSON.stringify({ ...(await state(track)), peak }));
await track.click(".us-ambient-btn");
await sleep(400);
await shot(track, "music-track");
await context.close();
