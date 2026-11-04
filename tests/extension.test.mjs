import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const FIXTURES = new URL("./fixtures/", import.meta.url);
const SHOTS = new URL("./screenshots/", import.meta.url);
const VIDEO_ID = "TESTVIDEO01";

let context, worker, extId;
const api = { requests: [], viewed: [] };

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

const media = { content: wav(120), ad: wav(30) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 5000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Не дождались условия, последнее значение: ${JSON.stringify(last)}`);
}

const setSettings = (patch) =>
  worker.evaluate(async (patch) => {
    const settings = US.merge((await chrome.storage.sync.get("settings")).settings);
    await chrome.storage.sync.set({ settings: { ...settings, ...patch } });
  }, patch);

const getStats = () => worker.evaluate(async () => (await chrome.storage.local.get("stats")).stats);

async function openYouTube(id = VIDEO_ID) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`https://www.youtube.com/watch?v=${id}`);
  await page.evaluate(() => yt.ready);
  page.errors = errors;
  return page;
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 900, height: 560 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
  });

  await context.route("https://www.youtube.com/**", async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.match(/^\/__media\/(\w+)\.wav$/)?.[1];
    if (name) return route.fulfill({ body: media[name], contentType: "audio/wav" });
    if (url.pathname === "/__adbreak") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ adBreak: { layouts: [{ adLayoutMetadata: { layoutId: "layout-midroll" } }] } }),
      });
    }
    route.fulfill({ body: await readFile(new URL("youtube.html", FIXTURES)), contentType: "text/html" });
  });
  await context.route("https://www.netflix.com/**", async (route) =>
    route.fulfill({ body: await readFile(new URL("netflix.html", FIXTURES)), contentType: "text/html" }));
  await context.route("https://sponsor.ajay.app/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/viewedVideoSponsorTime") {
      api.viewed.push(url.searchParams.get("UUID"));
      return route.fulfill({ status: 200, body: "" });
    }
    api.requests.push(url);
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        {
          videoID: VIDEO_ID,
          segments: [
            { category: "sponsor", segment: [10, 20], UUID: "seg-sponsor", actionType: "skip" },
            { category: "selfpromo", segment: [40, 46], UUID: "seg-selfpromo", actionType: "skip" },
            { category: "interaction", segment: [70, 75], UUID: "seg-interaction", actionType: "skip" },
          ],
        },
        { videoID: "OTHERVIDEO1", segments: [{ category: "sponsor", segment: [1, 2], UUID: "x", actionType: "skip" }] },
      ]),
    });
  });

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extId = new URL(worker.url()).host;
  await waitFor(() => worker.evaluate(async () => Boolean((await chrome.storage.sync.get("settings")).settings)));
});

after(async () => {
  await context?.close();
});

test("реклама: пропускается командой плеера сразу, не дожидаясь кнопки «Пропустить»", async () => {
  const page = await openYouTube();
  const started = Date.now();
  await page.evaluate(() => yt.startAd({ skippableAfter: 60000 }));
  await waitFor(() => page.evaluate(() => !document.querySelector("#movie_player").classList.contains("ad-showing")), { timeout: 3000 });
  assert.ok(Date.now() - started < 1000, `реклама продержалась ${Date.now() - started} мс`);
  assert.equal(await page.evaluate(() => yt.apiSkips), 1);
  assert.equal(await page.evaluate(() => yt.skipClicks), 0, "синтетические клики YouTube не засчитывает — пропуск идёт не через них");

  const stats = await waitFor(async () => (await getStats())?.total.ads && getStats());
  assert.equal(stats.total.ads, 1);
  assert.ok(stats.total.adSec >= 25, `сэкономлено ${stats.total.adSec} с`);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("реклама из отдельного запроса (середина видео) тоже пропускается командой плеера", async () => {
  const page = await openYouTube();
  await page.evaluate(() => yt.loadAdBreak());
  const started = Date.now();
  await page.evaluate(() => yt.startAd({ layoutId: "layout-midroll" }));
  await waitFor(() => page.evaluate(() => !document.querySelector("#movie_player").classList.contains("ad-showing")), { timeout: 3000 });
  assert.ok(Date.now() - started < 1000, `реклама продержалась ${Date.now() - started} мс`);
  assert.equal(await page.evaluate(() => yt.apiSkips), 1);
  await page.close();
});

test("реклама: без пропуска командой — закрыта, ×16 без звука, потом скорость и звук возвращаются", async () => {
  const page = await openYouTube();
  await page.evaluate(() => {
    yt.noApi = true;
    document.querySelector("video").playbackRate = 1.5;
  });
  await sleep(400);
  const started = Date.now();
  const cover = await page.evaluate(async () => {
    await yt.startAd();
    const p = document.querySelector("#movie_player");
    return { overlay: getComputedStyle(p, "::after").content, videoOpacity: getComputedStyle(p.querySelector("video")).opacity };
  });
  assert.match(cover.overlay, /пропускаем рекламу/);
  assert.equal(cover.videoOpacity, "1", "видео не прозрачное — иначе YouTube тормозит переход между роликами");

  const during = await waitFor(() =>
    page.evaluate(() => {
      const v = document.querySelector("video");
      return v.playbackRate === 16 && v.muted && v.currentTime > 0 && { rate: v.playbackRate, muted: v.muted };
    }));
  assert.deepEqual(during, { rate: 16, muted: true });

  await waitFor(() => page.evaluate(() => !document.querySelector("#movie_player").classList.contains("ad-showing")), { timeout: 5000 });
  assert.ok(Date.now() - started < 3500, `30-секундная реклама заняла ${Date.now() - started} мс`);
  await sleep(400);
  const afterAd = await page.evaluate(() => {
    const v = document.querySelector("video");
    return { rate: v.playbackRate, muted: v.muted, cover: getComputedStyle(document.querySelector("#movie_player"), "::after").content };
  });
  assert.deepEqual(afterAd, { rate: 1.5, muted: false, cover: "none" });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("реклама: следующий ролик в блоке сразу получает ×16, без ожидания цикла", async () => {
  const page = await openYouTube();
  await page.evaluate(() => {
    yt.noApi = true;
    return yt.startAd();
  });
  await waitFor(() => page.evaluate(() => document.querySelector("video").playbackRate === 16));
  const rates = await page.evaluate(async () => {
    const v = document.querySelector("video");
    await yt.nextAd();
    const seen = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 20));
      seen.push(v.playbackRate);
    }
    return seen;
  });
  assert.equal(rates.at(-1), 16, `скорости после смены ролика: ${rates}`);
  assert.ok(rates.filter((r) => r === 16).length >= 4, `скорости после смены ролика: ${rates}`);
  await page.evaluate(() => yt.endAd());
  await page.close();
});

test("реклама: настройки по отдельности — без пропуска команда не отправляется, без ускорения скорость не трогается", async () => {
  await setSettings({ ytSkipAds: false });
  let page = await openYouTube();
  await page.evaluate(() => yt.startAd());
  await sleep(700);
  assert.equal(await page.evaluate(() => yt.apiCalls), 0);
  assert.equal(await page.evaluate(() => document.querySelector("video").playbackRate), 16);
  await page.evaluate(() => yt.endAd());
  await page.close();

  await setSettings({ ytSkipAds: true, ytSpeedAds: false });
  page = await openYouTube();
  await page.evaluate(() => {
    yt.noApi = true;
    return yt.startAd();
  });
  await sleep(700);
  const state = await page.evaluate(() => ({
    rate: document.querySelector("video").playbackRate,
    cover: getComputedStyle(document.querySelector("#movie_player"), "::after").content,
  }));
  assert.deepEqual(state, { rate: 1, cover: "none" });
  await page.evaluate(() => yt.endAd());
  await setSettings({ ytSpeedAds: true });
  await page.close();
});

test("промо-блоки и Shorts скрываются по настройке", async () => {
  const page = await openYouTube();
  const display = (id) => page.evaluate((id) => getComputedStyle(document.getElementById(id)).display, id);
  assert.equal(await display("promo"), "none");
  assert.notEqual(await display("shorts"), "none");

  await setSettings({ ytHidePromos: false, ytHideShorts: true });
  await waitFor(async () => (await display("promo")) !== "none" && (await display("shorts")) === "none");
  await setSettings({ ytHidePromos: true, ytHideShorts: false });
  await page.close();
});

test("SponsorBlock: запрос по префиксу хэша, цветные отрезки на полосе", async () => {
  const page = await openYouTube();
  await waitFor(() => page.evaluate(() => document.querySelectorAll(".us-bar-seg").length === 3));

  const req = api.requests[0];
  const prefix = createHash("sha256").update(VIDEO_ID).digest("hex").slice(0, 4);
  assert.equal(req.pathname, `/api/skipSegments/${prefix}`, "ID видео не уходит на сервер");
  assert.deepEqual(JSON.parse(req.searchParams.get("categories")), ["sponsor", "selfpromo", "interaction"]);

  const marks = await page.evaluate(() =>
    [...document.querySelectorAll(".us-bar-seg")].map((m) => ({ left: m.style.left, bg: getComputedStyle(m).backgroundColor })));
  assert.ok(Math.abs(parseFloat(marks[0].left) - (10 / 120) * 100) < 0.01, marks[0].left);
  assert.equal(marks[0].bg, "rgb(0, 212, 0)");

  const badge = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return Promise.all(tabs.map((t) => chrome.action.getBadgeText({ tabId: t.id })));
  });
  assert.ok(badge.includes("3"), `бейдж: ${badge}`);
  await page.close();
});

test("SponsorBlock: категория при наведении — в плашке YouTube, а без неё — своя подсказка", async () => {
  const page = await openYouTube();
  await waitFor(() => page.evaluate(() => document.querySelectorAll(".us-bar-seg").length === 3));
  const point = await page.evaluate(() => {
    const r = document.querySelector(".ytp-progress-bar").getBoundingClientRect();
    return { x: r.left + (r.width * 43) / 120, y: r.top + r.height / 2 };
  });
  await page.mouse.move(point.x - 30, point.y);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  const pill = await waitFor(() => page.evaluate(() => document.querySelector(".ytp-tooltip-progress-bar-pill .us-pill-cat")?.textContent));
  assert.equal(pill, "Самореклама");
  assert.ok(await page.evaluate(() => document.querySelectorAll(".us-bar-seg")[1].classList.contains("us-hover")));
  await sleep(800);
  assert.ok(await page.evaluate(() => document.querySelector(".us-pill-cat")), "подпись не пропадает сама");
  await page.screenshot({ path: fileURLToPath(new URL("hover.png", SHOTS)) });

  await page.mouse.move(point.x - 50, point.y, { steps: 4 });
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-pill-cat")));

  await page.mouse.move(5, 5);
  await page.evaluate(() => (yt.tooltip = false));
  await page.mouse.move(point.x, point.y, { steps: 4 });
  const tip = await waitFor(() => page.evaluate(() => document.querySelector(".us-tip")?.textContent));
  assert.match(tip, /Самореклама/);
  assert.match(tip, /0:40–0:46/);

  await page.mouse.move(5, 5);
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-tip")));
  await page.close();
});

test("SponsorBlock: колебания длительности не пересоздают полосу", async () => {
  const page = await openYouTube();
  await waitFor(() => page.evaluate(() => document.querySelectorAll(".us-bar-seg").length === 3));
  await page.evaluate(() => (document.querySelector(".us-bar").dataset.marker = "1"));
  await page.evaluate(() => (document.querySelector(".us-bar").dataset.duration = "120.5"));
  await sleep(800);
  assert.equal(await page.evaluate(() => document.querySelector(".us-bar")?.dataset.marker), "1");
  await page.close();
});

test("SponsorBlock: автопропуск, уведомление справа снизу, «Назад» по Enter", async () => {
  api.viewed.length = 0;
  const statsBefore = (await getStats())?.total.segs ?? 0;
  const page = await openYouTube();
  await waitFor(() => page.evaluate(() => document.querySelectorAll(".us-bar-seg").length === 3));
  await page.evaluate(() => (document.querySelector("video").currentTime = 8.5));

  await waitFor(() => page.evaluate(() => document.querySelector("video").currentTime >= 20), { timeout: 4000 });
  const toast = await waitFor(() => page.evaluate(() => {
    const t = document.querySelector(".us-toast.us-show");
    if (!t) return null;
    const p = document.querySelector("#movie_player").getBoundingClientRect();
    const r = t.getBoundingClientRect();
    return { text: t.textContent, rightGap: p.right - r.right, bottomGap: p.bottom - r.bottom };
  }));
  assert.match(toast.text, /Пропущено: Спонсор/);
  assert.match(toast.text, /Назад \(Enter\)/);
  assert.match(toast.text, /\d с/);
  assert.ok(toast.rightGap < 40 && toast.bottomGap < 120, `позиция ${JSON.stringify(toast)}`);
  await page.screenshot({ path: fileURLToPath(new URL("toast-skipped.png", SHOTS)) });

  await waitFor(() => api.viewed.includes("seg-sponsor"));
  await waitFor(async () => (await getStats()).total.segs === statsBefore + 1);

  await page.keyboard.press("Enter");
  await waitFor(() => page.evaluate(() => Math.abs(document.querySelector("video").currentTime - 10) < 1));
  await sleep(1200);
  const t = await page.evaluate(() => document.querySelector("video").currentTime);
  assert.ok(t > 10 && t < 20, `после отмены вставка не пропускается повторно (t=${t})`);
  assert.equal(await page.evaluate(() => document.querySelector(".us-toast.us-show")), null);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("SponsorBlock: уведомление закрывается крестиком и само через 5 секунд", async () => {
  const page = await openYouTube();
  await waitFor(() => page.evaluate(() => document.querySelectorAll(".us-bar-seg").length === 3));
  await page.evaluate(() => (document.querySelector("video").currentTime = 39.5));
  await waitFor(() => page.evaluate(() => document.querySelector(".us-toast.us-show")));
  await page.click(".us-toast-close");
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-toast")));
  assert.ok(await page.evaluate(() => document.querySelector("video").currentTime >= 46), "закрытие не отменяет пропуск");

  await page.evaluate(() => (document.querySelector("video").currentTime = 69.5));
  await waitFor(() => page.evaluate(() => document.querySelector(".us-toast.us-show")));
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-toast")), { timeout: 7000 });
  await page.close();
});

test("SponsorBlock: режим «Кнопка» спрашивает и пропускает по Enter, «Метка» не пропускает", async () => {
  await setSettings({ sbModes: { ...(await worker.evaluate(() => US.DEFAULTS.sbModes)), sponsor: "manual", selfpromo: "show" } });
  const page = await openYouTube();
  await waitFor(() => page.evaluate(() => document.querySelectorAll(".us-bar-seg").length === 3));

  await page.evaluate(() => (document.querySelector("video").currentTime = 9.5));
  const prompt = await waitFor(() => page.evaluate(() => document.querySelector(".us-toast-prompt.us-show")?.textContent));
  assert.match(prompt, /Спонсор/);
  assert.match(prompt, /Пропустить \(Enter\)/);
  assert.ok(await page.evaluate(() => document.querySelector("video").currentTime < 20), "сам не пропускает");
  await page.screenshot({ path: fileURLToPath(new URL("toast-prompt.png", SHOTS)) });

  await page.keyboard.press("Enter");
  await waitFor(() => page.evaluate(() => document.querySelector("video").currentTime >= 20));

  await page.evaluate(() => (document.querySelector("video").currentTime = 39.5));
  await sleep(1500);
  const t = await page.evaluate(() => document.querySelector("video").currentTime);
  assert.ok(t > 40 && t < 46, `«Метка» не пропускает (t=${t})`);

  await setSettings({ sbModes: await worker.evaluate(() => US.DEFAULTS.sbModes) });
  await page.close();
});

test("SponsorBlock: смена видео без перезагрузки страницы сбрасывает отрезки", async () => {
  const page = await openYouTube();
  await waitFor(() => page.evaluate(() => document.querySelectorAll(".us-bar-seg").length === 3));
  await page.evaluate(() => history.pushState({}, "", "/watch?v=NOSEGMENTS1"));
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-bar")));
  await page.close();
});

test("Netflix: заставка пропускается, «Следующая серия» — только если включено", async () => {
  const page = await context.newPage();
  await page.goto("https://www.netflix.com/watch/1");
  await waitFor(() => page.evaluate(() => nf.intro === 1));
  await sleep(300);
  assert.equal(await page.evaluate(() => nf.next), 0);
  assert.ok((await getStats()).total.intros >= 1);
  await page.close();
});

test("попап: статистика, статус вкладки, переключатели сохраняются", async () => {
  const yt = await openYouTube();
  await waitFor(() => yt.evaluate(() => document.querySelectorAll(".us-bar-seg").length === 3));

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 1400 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await waitFor(() => popup.evaluate(() => document.querySelector("#statAds").textContent !== "0"));

  const status = await popup.evaluate(async () => {
    for (const tab of await chrome.tabs.query({})) {
      try {
        const s = await chrome.tabs.sendMessage(tab.id, { type: "status" }, { frameId: 0 });
        if (s?.site === "youtube") return s;
      } catch {}
    }
  });
  assert.equal(status.videoId, VIDEO_ID);
  assert.equal(status.segments.length, 3);
  assert.equal(status.duration, 120);
  assert.equal(status.skipModule, true, "модуль пропуска в мире страницы подключён");

  // Для скриншота показываем попап так, будто он открыт поверх вкладки YouTube.
  await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        if ((await chrome.tabs.sendMessage(tab.id, { type: "status" }, { frameId: 0 }))?.site === "youtube") {
          chrome.tabs.query = async () => [tab];
          return refreshNow();
        }
      } catch {}
    }
  });
  await waitFor(() => popup.evaluate(() => document.querySelectorAll(".segments li").length === 3));
  await popup.emulateMedia({ colorScheme: "dark" });
  await popup.screenshot({ path: fileURLToPath(new URL("popup-dark.png", SHOTS)), fullPage: true });
  await popup.emulateMedia({ colorScheme: "light" });
  await popup.screenshot({ path: fileURLToPath(new URL("popup-light.png", SHOTS)), fullPage: true });

  await popup.click('label:has([data-setting="ytHideShorts"])');
  await popup.click('.modes button[data-category="intro"][data-mode="auto"]');
  const saved = await worker.evaluate(async () => (await chrome.storage.sync.get("settings")).settings);
  assert.equal(saved.ytHideShorts, true);
  assert.equal(saved.sbModes.intro, "auto");

  await popup.click('.power');
  assert.equal(await popup.evaluate(() => document.body.classList.contains("off")), true);
  await waitFor(() => yt.evaluate(() => !document.querySelector(".us-bar")));
  await popup.click('.power');

  await setSettings({ ytHideShorts: false, sbModes: await worker.evaluate(() => US.DEFAULTS.sbModes) });
  await yt.close();
  await popup.close();
});
