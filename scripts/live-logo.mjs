// Снимает логотип YouTube и YouTube Music с включённым Fake Premium и показывает разметку логотипа Music.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const SHOTS = new URL("../tests/screenshots/", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 3,
  locale: "ru-RU",
  colorScheme: process.env.LIGHT ? "light" : "dark",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
await sleep(500);
await worker.evaluate(async () => {
  const settings = US.merge((await chrome.storage.sync.get("settings")).settings);
  await chrome.storage.sync.set({ settings: { ...settings, fakePremium: true } });
});

async function open(url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const reject = page.getByText(/^(Отклонить все|Reject all)$/).first();
  if (await reject.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false)) {
    await reject.click();
    await page.waitForURL(/youtube\.com\/(?!.*consent)/, { timeout: 15000 }).catch(() => {});
  }
  await sleep(4000);
  return page;
}

const yt = await open("https://www.youtube.com/");
console.log(await yt.evaluate(() => {
  const shape = document.querySelector("ytd-topbar-logo-renderer > a#logo ytd-logo .yt-icon-shape");
  const after = shape && getComputedStyle(shape, "::after");
  const paths = [...(shape?.querySelectorAll("svg path, svg g") ?? [])].map((p) => getComputedStyle(p).fill).filter((f, i, a) => a.indexOf(f) === i);
  return JSON.stringify({ paths, color: after?.color, dark: document.documentElement.hasAttribute("dark"), wordmarkVar: getComputedStyle(shape).getPropertyValue("--yt-spec-wordmark-text"), textPrimary: getComputedStyle(shape).getPropertyValue("--yt-spec-text-primary"), cls: [...document.documentElement.classList].filter((c) => c.startsWith("us-")), shape: !!shape, content: after?.content, display: after?.display, ancestors: (() => { const a = []; for (let x = shape; x && a.length < 6; x = x.parentElement) { const cs = getComputedStyle(x); a.push(x.tagName.toLowerCase() + ":" + cs.overflow + "/" + cs.contain); } return a.join(" < "); })() });
}));
await yt.screenshot({ path: fileURLToPath(new URL("logo-youtube.png", SHOTS)), clip: { x: 0, y: 0, width: 320, height: 56 } });

const music = await open("https://music.youtube.com/");
console.log(await music.evaluate(() => {
  const logo = document.querySelector("ytmusic-nav-bar .left-content, ytmusic-nav-bar #left-content, a.ytmusic-logo, ytmusic-logo");
  const desc = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
  const tree = (e, d = 0) => d > 6 ? "" : "  ".repeat(d) + desc(e) + " [" + Math.round(e.getBoundingClientRect().x) + "," + Math.round(e.getBoundingClientRect().width) + "x" + Math.round(e.getBoundingClientRect().height) + "]" + (e.getAttribute?.("src") ? " src=" + e.getAttribute("src").slice(0, 80) : "") + "\n" + [...e.children].filter((c) => !["path", "g", "defs"].includes(c.tagName)).map((c) => tree(c, d + 1)).join("");
  return location.host + "\n" + (logo ? tree(logo) : "logo not found");
}));
await music.screenshot({ path: fileURLToPath(new URL("logo-music.png", SHOTS)), clip: { x: 0, y: 0, width: 360, height: 64 } });
await context.close();
