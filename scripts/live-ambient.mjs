// Подсветка на живых YouTube и YouTube Music: включает её и снимает страницы (тёмная тема).
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const SHOTS = new URL("../tests/screenshots/", import.meta.url);
const videoId = process.argv[2] ?? "kJQP7kiw5Fk";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  header: Boolean(document.querySelector(".us-ambient-header.us-show")),
  host: document.querySelector(".us-ambient")?.parentElement?.id ?? null,
  ad: document.querySelector("#movie_player")?.classList.contains("ad-showing") ?? null,
}));

const yt = await open(`https://www.youtube.com/watch?v=${videoId}`);
for (let i = 0; i < 40 && !(await state(yt)).glow; i++) await sleep(1000);
await sleep(1500);
console.log("youtube", JSON.stringify(await state(yt)));
await yt.mouse.move(1430, 890);
await yt.screenshot({ path: fileURLToPath(new URL("live-ambient-youtube.png", SHOTS)) });

const music = await open(`https://music.youtube.com/watch?v=${videoId}`);
for (let i = 0; i < 40 && !(await state(music)).glow; i++) await sleep(1000);
await sleep(1500);
console.log("music", JSON.stringify(await state(music)));
await music.mouse.move(1430, 890);
await music.screenshot({ path: fileURLToPath(new URL("live-ambient-music.png", SHOTS)) });
await context.close();
