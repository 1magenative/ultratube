// Снимает скриншоты для README: настоящее расширение на демо-странице плеера (без чужих видео и логотипов).
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const OUT = new URL("../docs/screenshots/", import.meta.url);
const DEMO = new URL("./demo/player.html", import.meta.url);
const VIDEO_ID = "DEMOVIDEO01";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => fileURLToPath(new URL(name, OUT));

function wav(seconds, rate = 8000) {
  const data = Buffer.alloc(seconds * rate, 128);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const media = { content: wav(924), ad: wav(30) };
const segments = [
  { category: "sponsor", segment: [181, 249], UUID: "demo-1", actionType: "skip" },
  { category: "selfpromo", segment: [610, 652], UUID: "demo-2", actionType: "skip" },
  { category: "interaction", segment: [838, 850], UUID: "demo-3", actionType: "skip" },
  { category: "poi_highlight", segment: [372, 372], UUID: "demo-4", actionType: "poi" },
];

await mkdir(OUT, { recursive: true });
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  viewport: { width: 1008, height: 680 },
  deviceScaleFactor: 2,
  locale: "ru-RU",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});

await context.route("https://www.youtube.com/**", async (route) => {
  const name = new URL(route.request().url()).pathname.match(/^\/__media\/(\w+)\.wav$/)?.[1];
  if (name) return route.fulfill({ body: media[name], contentType: "audio/wav" });
  route.fulfill({ body: await readFile(DEMO), contentType: "text/html" });
});
await context.route("https://returnyoutubedislikeapi.com/**", (route) =>
  route.fulfill({ contentType: "application/json", body: JSON.stringify({ likes: 7100, dislikes: 214 }) }));
await context.route("https://sponsor.ajay.app/**", (route) => {
  if (route.request().method() === "POST") return route.fulfill({ status: 200, body: "" });
  route.fulfill({ contentType: "application/json", body: JSON.stringify([{ videoID: VIDEO_ID, segments }]) });
});

const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const extId = new URL(worker.url()).host;
const setModes = (patch) =>
  worker.evaluate(async (patch) => {
    const settings = US.merge((await chrome.storage.sync.get("settings")).settings);
    await chrome.storage.sync.set({ settings: { ...settings, sbModes: { ...US.DEFAULTS.sbModes, ...patch } } });
  }, patch);
await sleep(500);

async function openPlayer() {
  const page = await context.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  await page.evaluate(() => demo.ready);
  await page.waitForFunction(() => document.querySelectorAll(".us-bar-seg").length === 3);
  return page;
}
const playerClip = { x: 24, y: 24, width: 960, height: 540 };

// 1. Подсказка с категорией при наведении на отрезок.
let page = await openPlayer();
await page.evaluate(() => (document.querySelector("video").currentTime = 95));
const point = await page.evaluate(() => {
  const r = document.querySelector(".ytp-progress-bar").getBoundingClientRect();
  const d = document.querySelector("video").duration;
  return { x: r.left + (r.width * 630) / d, y: r.top + r.height / 2 };
});
await page.mouse.move(point.x - 40, point.y);
await page.mouse.move(point.x, point.y, { steps: 5 });
await page.waitForSelector(".us-pill-cat");
await sleep(300);
await page.screenshot({ path: shot("hover.png"), clip: playerClip });

// 1б. Кнопка «К главному» в плеере и дизлайки под видео.
await page.mouse.move(500, 200);
await page.waitForSelector(".us-highlight-btn");
await page.waitForSelector(".us-dislikes");
await sleep(300);
await page.screenshot({ path: shot("player-extras.png"), clip: { x: 24, y: 24, width: 960, height: 640 } });

// 2. Автопропуск: уведомление справа снизу.
await page.mouse.move(500, 200);
await page.evaluate(() => (document.querySelector("video").currentTime = 180.4));
await page.waitForSelector(".us-toast.us-show");
await sleep(400);
await page.screenshot({ path: shot("autoskip.png"), clip: playerClip });
await page.close();

// 3. Режим «Кнопка»: предложение пропустить.
await setModes({ sponsor: "manual" });
page = await openPlayer();
await page.evaluate(() => (document.querySelector("video").currentTime = 181.5));
await page.waitForSelector(".us-toast-prompt.us-show");
await sleep(400);
await page.screenshot({ path: shot("manual.png"), clip: playerClip });
await page.close();
await setModes({});

// 4. Реклама: картинка закрыта, пока плеер её пропускает.
page = await openPlayer();
await page.evaluate(() => demo.showAd());
await sleep(120);
await page.screenshot({ path: shot("ad.png"), clip: playerClip });
await page.close();

// 5. Попап поверх вкладки с видео, со статистикой за несколько недель.
await worker.evaluate(async () => {
  const today = new Date().toLocaleDateString("sv");
  await chrome.storage.local.set({
    stats: {
      total: { ads: 214, adSec: 6930, segs: 87, segSec: 3610, intros: 23 },
      days: { [today]: { ads: 9, adSec: 312, segs: 4, segSec: 171, intros: 1 } },
    },
  });
});
const ytPage = await openPlayer();
await ytPage.evaluate(() => (document.querySelector("video").currentTime = 300));
const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 600 });
await worker.evaluate(() => chrome.storage.local.set({ channelSpeeds: { UC_DEMO: { name: "Мастерская", rate: 1.5 } } }));
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.evaluate(async () => {
  for (const tab of await chrome.tabs.query({})) {
    try {
      if ((await chrome.tabs.sendMessage(tab.id, { type: "status" }, { frameId: 0 }))?.site === "youtube") {
        chrome.tabs.query = async () => [tab];
        return refreshNow();
      }
    } catch {}
  }
});
await popup.waitForFunction(() => document.querySelectorAll(".segments li").length === 3);
await popup.waitForSelector(".channel");
await popup.emulateMedia({ colorScheme: "dark" });
for (const tab of ["overview", "ads", "segments", "player", "view"]) {
  await popup.click(`[data-tab="${tab}"]`);
  await sleep(150);
  await popup.screenshot({ path: shot(`popup-${tab}.png`), fullPage: true });
}
await popup.click('[data-tab="overview"]');
await popup.emulateMedia({ colorScheme: "light" });
await sleep(200);
await popup.screenshot({ path: shot("popup-light.png"), fullPage: true });

await context.close();
console.log("screenshots →", fileURLToPath(OUT));
