import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const SHOTS = new URL("../tests/screenshots/", import.meta.url);
const videoId = process.argv[2] ?? "XkELKJA4qpA";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 800 },
  locale: "ru-RU",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error" && /us-|ultra|youtube\.js|chrome-extension/i.test(m.text() + JSON.stringify(m.location()))) console.log("console:", m.text().slice(0, 200), JSON.stringify(m.location())); });
await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: "domcontentloaded" });
const reject = page.getByText(/^(Отклонить все|Reject all)$/).first();
if (await reject.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false)) await reject.click();

await page.waitForFunction(() => document.querySelectorAll(".us-bar-seg").length > 0, null, { timeout: 30000 });
const marks = await page.evaluate(() => [...document.querySelectorAll(".us-bar-seg")].map((m) => {
  const r = m.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, color: m.style.background };
}));
if (await reject.isVisible()) {
  await reject.click();
  await sleep(1500);
}
console.log("marks", JSON.stringify(marks));

await page.evaluate(() => {
  window.__ev = {};
  const bar = document.querySelector(".ytp-progress-bar");
  for (const type of ["mousemove", "pointermove", "mouseover"]) {
    bar.addEventListener(type, () => (__ev["bar-" + type] = (__ev["bar-" + type] ?? 0) + 1));
    document.addEventListener(type, () => (__ev["doc-" + type] = (__ev["doc-" + type] ?? 0) + 1), true);
  }
});
const target = marks.reduce((a, b) => (b.w > a.w ? b : a));
await page.mouse.move(target.x - 40, target.y - 60);
await sleep(300);
await page.mouse.move(target.x, target.y, { steps: 8 });
await sleep(600);
console.log("hover", JSON.stringify(await page.evaluate(({ x, y }) => {
  const chain = [];
  for (let e = document.elementFromPoint(x, y); e && chain.length < 6; e = e.parentElement) chain.push(e.tagName.toLowerCase() + "." + [...e.classList].join("."));
  const tip = document.querySelector(".us-pill-cat") ?? document.querySelector(".us-tip");
  const r = tip?.getBoundingClientRect();
  return { chain, tip: tip?.textContent ?? null, rect: r && [r.left, r.top, r.width, r.height], hovered: document.querySelectorAll(".us-hover").length };
}, target)));
console.log("players", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("#movie_player, .html5-video-player")].map((p) => ({ id: p.id, bars: p.querySelectorAll(".ytp-progress-bar").length, ours: p.querySelectorAll(".us-bar").length })))));
console.log("debug", await page.evaluate(() => [document.querySelector("#movie_player").dataset.usDebug, document.querySelector("#movie_player").dataset.usBind, document.querySelector("#movie_player").dataset.usRender]));
console.log("tooltip", await page.evaluate(() => {
  const t = document.querySelector(".ytp-tooltip");
  const walk = (e, d) => d > 6 ? "" : "  ".repeat(d) + e.tagName.toLowerCase() + "." + [...e.classList].join(".") + (e.children.length ? "" : " = " + JSON.stringify(e.textContent.slice(0, 40))) + " " + (getComputedStyle(e).display) + "\n" + [...e.children].map((c) => walk(c, d + 1)).join("");
  return t ? walk(t, 0) : "none";
}));
console.log("events", JSON.stringify(await page.evaluate(() => window.__ev)));
await page.screenshot({ path: fileURLToPath(new URL("live-hover.png", SHOTS)) });
await context.close();
