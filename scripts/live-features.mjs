// Проверка новых функций на живом YouTube: качество, скорость, «К главному», дизлайки, автовоспроизведение, скрытие.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const SHOTS = new URL("../tests/screenshots/", import.meta.url);
const videoId = process.argv[2] ?? "KyTgvancEok";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 900 },
  locale: "ru-RU",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
await sleep(500);
await worker.evaluate(async () => {
  const settings = US.merge((await chrome.storage.sync.get("settings")).settings);
  Object.assign(settings, { ytQuality: "max", ytSpeed: 1.5, ytNoAutoplay: true, hideRecs: true, hideComments: true });
  await chrome.storage.sync.set({ settings });
});

const page = await context.newPage();
await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: "domcontentloaded" });
const reject = page.getByText(/^(Отклонить все|Reject all)$/).first();
if (await reject.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false)) {
  await reject.click();
  await sleep(2000);
}

const report = async () => page.evaluate(() => {
  const p = document.querySelector("#movie_player");
  const v = p?.querySelector("video");
  const shown = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).display !== "none" : null;
  };
  return {
    ad: p?.classList.contains("ad-showing"),
    channel: document.documentElement.dataset.usChannel,
    quality: p?.getPlaybackQuality?.(),
    preferred: p?.getPreferredQuality?.(),
    playing: v ? !v.paused && v.readyState >= 3 : null,
    levels: p?.getAvailableQualityLevels?.().slice(0, 3).join(","),
    rate: v?.playbackRate,
    highlight: document.querySelector(".us-highlight-btn")?.title ?? null,
    poiMark: Boolean(document.querySelector(".us-bar-poi")),
    dislikes: [...document.querySelectorAll("dislike-button-view-model .us-dislikes")].map((e) => e.textContent).join(" | ") || null,
    autonav: p?.querySelector(".ytp-autonav-toggle")?.getAttribute("data-tooltip-title") ?? null,
    relatedShown: shown("ytd-watch-flexy #secondary #related"),
    commentsShown: shown("ytd-watch-flexy #comments"),
  };
});

let last;
for (let i = 0; i < 30; i++) {
  last = await report();
  if (!last.ad && last.highlight && last.dislikes && last.quality && last.rate === 1.5) break;
  await sleep(1000);
}
console.log(JSON.stringify(last, null, 2));
await page.mouse.move(640, 300);
await page.screenshot({ path: fileURLToPath(new URL("live-features.png", SHOTS)) });
await context.close();
