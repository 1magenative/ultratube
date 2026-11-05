// Звук на живом YouTube: оригинальная дорожка вместо дубляжа (ролик MrBeast, где YouTube включает русскую озвучку),
// усиление, выравнивание, ночной режим и эквалайзер, панель «Звук»; затем пульс подсветки в YouTube Music.
// node scripts/live-audio.mjs [videoId] [audioTrackId]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const SHOTS = new URL("../tests/screenshots/", import.meta.url);
const videoId = process.argv[2] ?? "0e3GPea1Tyg";
const trackId = process.argv[3] ?? "1IWsqTqAjeI";
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
const set = (patch) => worker.evaluate(async (patch) => {
  const settings = US.merge((await chrome.storage.sync.get("settings")).settings);
  await chrome.storage.sync.set({ settings: { ...settings, ...patch } });
}, patch);

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

const track = (page) => page.evaluate(() => {
  const p = document.querySelector("#movie_player");
  const info = (t) => Object.values(t ?? {}).find((v) => v && typeof v === "object" && "isAutoDubbed" in v);
  return { current: info(p?.getAudioTrack?.())?.name ?? null, ad: p?.classList.contains("ad-showing") };
});
const audio = (page) => page.evaluate(() => ({
  chain: JSON.parse(document.documentElement.dataset.usAudio || "null"),
  loudness: document.documentElement.dataset.usLoudness,
  paused: document.querySelector("#movie_player video")?.paused,
  time: document.querySelector("#movie_player video")?.currentTime,
  ready: document.querySelector("#movie_player video")?.readyState,
  playerState: document.querySelector("#movie_player")?.getPlayerState?.(),
}));

const yt = await open(`https://www.youtube.com/watch?v=${videoId}`);
let state;
for (let i = 0; i < 30; i++) {
  state = await track(yt);
  if (state.current && !state.ad && /оригинал|original/i.test(state.current)) break;
  await sleep(1000);
}
console.log("дорожка", JSON.stringify(state));

await set({ audioBoostOn: true, audioBoost: 200, audioNormalize: true, audioNight: true, audioEq: true, audioEqPreset: "voice" });
await yt.mouse.click(1300, 30);
await sleep(3000);
console.log("звук", JSON.stringify(await audio(yt)));
for (const wait of [2000, 4000, 4000]) {
  await sleep(wait);
  console.log("звук", JSON.stringify(await audio(yt)));
}
await yt.mouse.move(700, 400);
await yt.click(".us-audio-btn");
await sleep(500);
await yt.screenshot({ path: fileURLToPath(new URL("live-audio-panel.png", SHOTS)) });
await yt.close();
await set({ audioBoostOn: false, audioNormalize: false, audioNight: false, audioEq: false, ambientMusic: true });

const music = await open(`https://music.youtube.com/watch?v=${trackId}`);
await sleep(8000);
await music.mouse.click(700, 32);
let peak = 0;
for (let i = 0; i < 60; i++) {
  peak = Math.max(peak, await music.evaluate(() => Number(document.querySelector(".us-ambient")?.style.getPropertyValue("--us-pulse")) || 0));
  await sleep(50);
}
console.log("пульс в YouTube Music", peak, JSON.stringify(await audio(music)));
await context.close();
