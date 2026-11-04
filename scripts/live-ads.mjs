import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const SHOTS = new URL("../tests/screenshots/", import.meta.url);
const videoId = process.argv[2] ?? "kJQP7kiw5Fk";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: false,
  viewport: { width: 1280, height: 800 },
  locale: "ru-RU",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});
const page = await context.newPage();
await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: "domcontentloaded" });
const reject = page.getByText(/^(Отклонить все|Reject all)$/).first();
if (await reject.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false)) await reject.click();

let sawAd = false;
for (let i = 0; i < 90; i++) {
  const s = await page.evaluate(() => {
    const p = document.querySelector("#movie_player");
    const v = p?.querySelector("video");
    return { ad: p?.classList.contains("ad-showing") ?? false, t: v ? +v.currentTime.toFixed(1) : null, rate: v?.playbackRate, muted: v?.muted };
  }).catch(() => ({}));
  if (s.ad && !sawAd) await page.screenshot({ path: fileURLToPath(new URL("live-ad.png", SHOTS)) });
  sawAd ||= s.ad;
  console.log(JSON.stringify(s));
  if (sawAd && !s.ad && s.t > 2) break;
  if (!sawAd && s.t > 15) break;
  await sleep(500);
}
const stats = await context.serviceWorkers()[0]?.evaluate(async () => (await chrome.storage.local.get("stats")).stats);
console.log("sawAd:", sawAd, "stats:", JSON.stringify(stats?.total));
await context.close();
