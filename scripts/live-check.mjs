import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const SHOTS = new URL("../tests/screenshots/", import.meta.url);
const videoId = process.argv[2] ?? "XkELKJA4qpA";
const seekTo = Number(process.argv[3] ?? 178);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: process.env.HEADED ? false : true,
  viewport: { width: 1280, height: 800 },
  locale: "ru-RU",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: "domcontentloaded" });

// В ЕС YouTube сначала показывает окно cookie — выбираем «Отклонить все».
const reject = page.getByText(/^(Отклонить все|Reject all)$/).first();
if (await reject.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false)) {
  await reject.click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(2000);
}

const state = () => page.evaluate(() => {
  const p = document.querySelector("#movie_player");
  const v = p?.querySelector("video");
  return {
    url: location.href.slice(0, 80),
    player: Boolean(p),
    ad: p?.classList.contains("ad-showing") ?? null,
    t: v ? +v.currentTime.toFixed(1) : null,
    dur: v?.duration ?? null,
    rate: v?.playbackRate,
    muted: v?.muted,
    paused: v?.paused,
    marks: document.querySelectorAll(".us-bar-seg").length,
    progressBar: Boolean(p?.querySelector(".ytp-progress-bar")),
    toast: document.querySelector(".us-toast")?.textContent ?? null,
    promoHidden: document.documentElement.classList.contains("us-hide-promos"),
  };
});

for (let i = 0; i < 40; i++) {
  const s = await state();
  console.log(JSON.stringify(s));
  if (s.marks && !s.ad && s.dur > 0) break;
  await sleep(1000);
}
await page.screenshot({ path: fileURLToPath(new URL("live-start.png", SHOTS)) });

await page.evaluate((t) => {
  const v = document.querySelector("#movie_player video");
  v.currentTime = t;
  v.play();
}, seekTo);
for (let i = 0; i < 8; i++) {
  await sleep(500);
  const s = await state();
  console.log(JSON.stringify(s));
  if (s.toast && i > 1) break;
}
await page.mouse.move(640, 400);
await page.screenshot({ path: fileURLToPath(new URL("live-skip.png", SHOTS)) });
console.log("styles:", await page.evaluate(() => {
  const pick = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const c = getComputedStyle(e), r = e.getBoundingClientRect();
    return { top: r.top, h: r.height, transform: c.transform, origin: c.transformOrigin, transition: c.transition.slice(0, 80) };
  };
  return { container: pick(".ytp-progress-bar-container"), bar: pick(".ytp-progress-bar"), list: pick(".ytp-progress-list"), play: pick(".ytp-play-progress"), ours: pick(".us-bar") };
}));
await page.hover(".ytp-progress-bar").catch(() => {});
await sleep(400);
console.log("hover list:", await page.evaluate(() => {
  const e = document.querySelector(".ytp-progress-list"), r = e.getBoundingClientRect();
  return { top: r.top, h: r.height, transform: getComputedStyle(e).transform };
}));
await page.screenshot({ path: fileURLToPath(new URL("live-hover.png", SHOTS)) });
console.log("bar DOM:", await page.evaluate(() => {
  const bar = document.querySelector(".us-bar");
  const host = bar?.parentElement;
  const r = bar?.getBoundingClientRect();
  const lr = document.querySelector(".ytp-progress-list")?.getBoundingClientRect();
  return { host: host?.className, bar: r && [r.top, r.height, r.width], list: lr && [lr.top, lr.height, lr.width] };
}));
await context.close();
