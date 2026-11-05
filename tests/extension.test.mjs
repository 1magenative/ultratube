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
const api = { requests: [], viewed: [], dislikes: [] };

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

// «Бочка»: короткий удар 120 Гц каждые полсекунды — для подсветки в такт музыке.
function beatWav(seconds, rate = 8000) {
  const file = wav(seconds, rate);
  for (let i = 0; i < seconds * rate; i++) {
    const t = (i / rate) % 0.5;
    if (t < 0.15) file[44 + i] = 128 + Math.round(120 * Math.sin(2 * Math.PI * 120 * t) * (1 - t / 0.15));
  }
  return file;
}

const media = { content: wav(120), ad: wav(30), beat: beatWav(20), color: null };
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

  const youtube = async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.match(/^\/__media\/(\w+)\.wav$/)?.[1];
    if (name) return route.fulfill({ body: media[name], contentType: "audio/wav" });
    if (url.pathname === "/__media/color.webm") return route.fulfill({ body: media.color, contentType: "video/webm" });
    if (url.hostname === "music.youtube.com" && url.pathname === "/ambient") {
      return route.fulfill({ body: await readFile(new URL("music.html", FIXTURES)), contentType: "text/html" });
    }
    if (url.pathname === "/__adbreak") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ adBreak: { layouts: [{ adLayoutMetadata: { layoutId: "layout-midroll" } }] } }),
      });
    }
    route.fulfill({ body: await readFile(new URL("youtube.html", FIXTURES)), contentType: "text/html" });
  };
  await context.route("https://www.youtube.com/**", youtube);
  await context.route("https://music.youtube.com/**", youtube);
  await context.route("https://returnyoutubedislikeapi.com/**", (route) => {
    api.dislikes.push(new URL(route.request().url()).searchParams.get("videoId"));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: VIDEO_ID, likes: 1200, dislikes: 3456 }) });
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
            { category: "poi_highlight", segment: [95, 95], UUID: "seg-poi", actionType: "poi" },
          ],
        },
        { videoID: "OTHERVIDEO1", segments: [{ category: "sponsor", segment: [1, 2], UUID: "x", actionType: "skip" }] },
      ]),
    });
  });

  // Короткий ролик с настоящими кадрами: браузер сам записывает его из canvas.
  const recorder = await context.newPage();
  media.color = Buffer.from(await recorder.evaluate(async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 160, height: 90 });
    const ctx = canvas.getContext("2d");
    const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    const until = performance.now() + 1500;
    await new Promise((done) => {
      const draw = () => {
        ctx.fillStyle = "#ff2000";
        ctx.fillRect(0, 0, 80, 90);
        ctx.fillStyle = "#0040ff";
        ctx.fillRect(80, 0, 80, 90);
        if (performance.now() < until) requestAnimationFrame(draw);
        else done();
      };
      draw();
    });
    rec.stop();
    await new Promise((r) => (rec.onstop = r));
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }), "base64");
  await recorder.close();

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
  assert.deepEqual(JSON.parse(req.searchParams.get("categories")), ["sponsor", "selfpromo", "interaction", "poi_highlight"]);
  assert.deepEqual(JSON.parse(req.searchParams.get("actionTypes")), ["skip", "poi"]);

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

test("«К главному»: метка SponsorBlock — кнопка в плеере и метка на полосе", async () => {
  const page = await openYouTube();
  const title = await waitFor(() => page.evaluate(() => document.querySelector(".us-highlight-btn")?.title));
  assert.match(title, /1:35/);
  assert.match(title, /SponsorBlock/);
  assert.ok(await page.evaluate(() => document.querySelector(".us-bar-poi")));
  await page.click(".us-highlight-btn");
  await waitFor(() => page.evaluate(() => Math.abs(document.querySelector("video").currentTime - 95) < 1));
  await page.close();
});

test("«К главному» без метки: пик графика «самых пересматриваемых»", async () => {
  const page = await openYouTube("HEATMAPVID1");
  await sleep(500);
  assert.equal(await page.evaluate(() => document.querySelector(".us-highlight-btn")), null, "нет данных — нет кнопки");
  // Пик на 60% длины: x=600 из 1000, y=5 из 100 (чем меньше y, тем выше пик).
  await page.evaluate(() => yt.setHeatmap("M 0,100 C 100,90 200,10 300,60 C 400,80 500,40 600,5 C 700,40 800,70 1000,100"));
  const title = await waitFor(() => page.evaluate(() => document.querySelector(".us-highlight-btn")?.title));
  assert.match(title, /1:12/);
  assert.match(title, /пересматриваемые/);
  await page.close();
});

test("«Продолжить просмотр?» подтверждается само, если пользователь ничего не нажимал", async () => {
  const page = await openYouTube();
  await sleep(3200);
  await page.evaluate(() => yt.showStillWatching());
  await waitFor(() => page.evaluate(() => yt.stillConfirmed === 1));
  await waitFor(() => page.evaluate(() => !document.querySelector("video").paused));
  await page.close();
});

test("автовоспроизведение следующего видео выключается по настройке", async () => {
  const page = await openYouTube();
  await sleep(1200);
  assert.equal(await page.evaluate(() => document.querySelector(".ytp-autonav-toggle-button").getAttribute("aria-checked")), "true");
  await setSettings({ ytNoAutoplay: true });
  await waitFor(() => page.evaluate(() => document.querySelector(".ytp-autonav-toggle-button").getAttribute("aria-checked") === "false"));
  await setSettings({ ytNoAutoplay: false });
  await page.close();
});

test("дизлайки из Return YouTube Dislike показываются на кнопке и убираются по настройке", async () => {
  const page = await openYouTube();
  const text = await waitFor(() => page.evaluate(() => document.querySelector("dislike-button-view-model .us-dislikes")?.textContent));
  assert.match(text, /^3,5\s?тыс\.$/);
  assert.ok(api.dislikes.includes(VIDEO_ID));
  assert.ok(await page.evaluate(() => document.querySelector("dislike-button-view-model button").classList.contains("ytSpecButtonShapeNextIconLeading")));
  await setSettings({ ytDislikes: false });
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-dislikes")));
  await setSettings({ ytDislikes: true });
  await page.close();
});

test("«Без отвлекающего»: лента, рекомендации, комментарии, карточки скрываются по настройкам", async () => {
  const page = await openYouTube();
  const hidden = () => page.evaluate(() =>
    ["homefeed", "related", "comments", "endcard"].map((id) => getComputedStyle(document.getElementById(id)).display === "none"));
  assert.deepEqual(await hidden(), [false, false, false, false]);
  await setSettings({ hideHomeFeed: true, hideRecs: true, hideComments: true, hideEndCards: true });
  await waitFor(async () => (await hidden()).every(Boolean));
  await setSettings({ hideHomeFeed: false, hideRecs: false, hideComments: false, hideEndCards: false });
  await waitFor(async () => !(await hidden()).some(Boolean));
  await page.close();
});

test("главная без дыр: спрятанная реклама не оставляет пустое место перед полкой", async () => {
  const page = await openYouTube();
  const layout = () => page.evaluate(() => {
    const items = [...document.querySelectorAll("#grid ytd-rich-item-renderer")]
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => ({ text: el.textContent.trim(), y: Math.round(el.getBoundingClientRect().y), x: Math.round(el.getBoundingClientRect().x) }));
    const shelf = document.getElementById("shelf").getBoundingClientRect();
    return { items, shelfY: Math.round(shelf.y), shelfW: Math.round(shelf.width) };
  });
  const { items, shelfY, shelfW } = await layout();
  assert.equal(items.length, 7, "рекламная карточка скрыта");
  const before = items.filter((i) => i.y < shelfY);
  assert.equal(before.length, 6, `перед полкой два полных ряда, а не ${before.length} карточек`);
  assert.equal(new Set(before.map((i) => i.x)).size, 3, "три ровные колонки");
  assert.equal(shelfW, 900, "полка на всю ширину");
  await page.close();
});

test("Fake Premium: надпись у логотипов YouTube и YouTube Music по настройке", async () => {
  const page = await openYouTube();
  const read = () => page.evaluate(() => ({
    yt: getComputedStyle(document.querySelector("ytd-topbar-logo-renderer .yt-icon-shape"), "::after").content,
    music: getComputedStyle(document.querySelector("ytmusic-logo a"), "::after").content,
    country: getComputedStyle(document.getElementById("country-code")).display,
  }));
  assert.deepEqual(await read(), { yt: "none", music: "none", country: "inline" });
  await setSettings({ fakePremium: true });
  await waitFor(async () => (await read()).yt === '"Premium"');
  assert.deepEqual(await read(), { yt: '"Premium"', music: '"Premium"', country: "none" });
  await setSettings({ fakePremium: false });
  await page.close();
});

test("скорость выше 2×: ряд UltraTube вместо Premium-кнопки, «+»/«−», возврат на «2,0», клавиши", async () => {
  const page = await openYouTube();
  const rate = () => page.evaluate(() => document.querySelector("video").playbackRate);
  const display = () => page.evaluate(() => document.querySelector(".ytp-variable-speed-panel-display span").textContent);
  await page.waitForSelector(".us-speed-chip");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("premiumWrapper")).display), "none");
  assert.deepEqual(await page.$$eval(".us-speed-chip", (els) => els.map((e) => e.textContent)), ["2,5", "3,0", "3,5", "4,0"]);

  await page.click('.us-speed-chip:has-text("3,0")');
  assert.equal(await rate(), 3);
  await waitFor(async () => (await display()) === "3.00x");
  assert.equal(await page.evaluate(() => document.querySelector(".ytp-menuitem-content").textContent), "3");
  await page.click("#speedPlus");
  assert.equal(await rate(), 3.25);
  await page.click('.us-speed-chip:has-text("4,0")');
  await page.click("#speedPlus");
  assert.equal(await rate(), 4, "не выше 4×");
  await page.click("#speedMinus");
  assert.equal(await rate(), 3.75);
  await page.click("#chip2");
  assert.equal(await rate(), 2, "«2,0» работает, хотя плеер считает, что уже стоит 2×");
  await waitFor(async () => (await display()) === "2.00x");
  assert.equal(await page.evaluate(() => yt.upsell), 0);

  await page.keyboard.press("Shift+Period");
  assert.equal(await rate(), 2.25);
  await page.keyboard.press("Shift+Comma");
  assert.equal(await rate(), 2);
  assert.ok(await page.evaluate(() => document.querySelector(".us-speed-bezel.us-show")), "подсказка скорости на видео");

  await setSettings({ ytFastSpeed: false });
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-speed-chip")));
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById("premiumWrapper")).display), "none");
  await setSettings({ ytFastSpeed: true });
  await page.close();
});

test("Shorts в обычном плеере: адрес и ссылки по настройке", async () => {
  await setSettings({ ytShortsAsVideo: true });
  const page = await context.newPage();
  await page.goto(`https://www.youtube.com/shorts/${VIDEO_ID}`);
  await page.waitForURL(`**/watch?v=${VIDEO_ID}`);
  await page.evaluate(() => yt.ready);
  await page.click("#shortslink");
  await page.waitForURL("**/watch?v=OTHERVIDEO1");

  await setSettings({ ytShortsAsVideo: false });
  await page.goto(`https://www.youtube.com/shorts/${VIDEO_ID}`);
  await sleep(800);
  assert.match(page.url(), /\/shorts\//, "без настройки Shorts остаются Shorts");
  await page.close();
});

test("страница приветствия открывается при установке", async () => {
  const welcome = await waitFor(() => context.pages().find((p) => p.url().endsWith("/welcome/welcome.html")));
  assert.equal(await welcome.textContent("h1"), "UltraTube");
  assert.match(await welcome.textContent("#version"), /^\d+\.\d+\.\d+$/);
  assert.ok((await welcome.$$(".feature")).length >= 8);
});

test("подсветка на YouTube: свечение в цветах кадра под плеером и в шапке, кинорежим YouTube скрыт", async () => {
  const page = await openYouTube();
  await page.evaluate(() => yt.playColor());
  await sleep(400);
  assert.equal(await page.evaluate(() => document.querySelector(".us-ambient")), null, "по умолчанию выключена");

  await setSettings({ ambient: true, ambientStrength: 100 });
  await waitFor(() => page.evaluate(() => document.querySelector("#player > .us-ambient.us-show")));
  const colors = await page.evaluate(() => {
    const c = document.querySelector(".us-ambient-canvas");
    const px = (x) => [...c.getContext("2d").getImageData(x, 13, 1, 1).data.slice(0, 3)];
    return { left: px(10), right: px(38) };
  });
  assert.ok(colors.left[0] > 180 && colors.left[2] < 90, `слева красный: ${colors.left}`);
  assert.ok(colors.right[2] > 180 && colors.right[0] < 90, `справа синий: ${colors.right}`);
  assert.ok(await page.evaluate(() => document.querySelector("ytd-masthead #background > .us-ambient-header.us-show")));
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("cinematics-container")).display), "none");
  assert.equal(await page.evaluate(() => document.querySelector(".us-ambient").style.getPropertyValue("--us-glow-opacity")), "1.00");
  assert.equal(await page.evaluate(() => document.querySelector(".us-ambient-fill.us-show")), null, "видео во весь плеер — полос нет");

  // Чёрные полосы внутри плеера (полный экран, 4:3) тоже светятся.
  await page.evaluate(() => (document.querySelector("#movie_player video").style.width = "50%"));
  await waitFor(() => page.evaluate(() => document.querySelector("#movie_player > .us-ambient-fill.us-show")));
  await page.evaluate(() => (document.querySelector("#movie_player video").style.width = "100%"));
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-ambient-fill.us-show")));

  // Переключатель своей подсветки YouTube при нашей ничего не делает — он спрятан.
  assert.equal(await page.evaluate(() => document.getElementById("yt-lighting").classList.contains("us-yt-hidden")), true);

  // Кнопка в плеере открывает панель: яркость меняется сразу и сохраняется.
  await page.click(".ytp-right-controls-left > .us-ambient-btn");
  assert.ok(await page.isVisible("#movie_player > .us-ambient-panel"));
  await page.fill(".us-ambient-panel .us-ap-range >> nth=0", "40");
  assert.equal(await page.evaluate(() => document.querySelector(".us-ambient").style.getPropertyValue("--us-glow-opacity")), "0.52");
  assert.equal(await page.inputValue(".us-ambient-panel .us-ap-num >> nth=0"), "40");
  // Значение можно ввести с клавиатуры — целое, в пределах ползунка.
  await page.click(".us-ambient-panel .us-ap-num >> nth=0");
  await page.keyboard.type("63");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.sync.get("settings")).settings.ambientStrength)) === 63);
  assert.equal(await page.inputValue(".us-ambient-panel .us-ap-range >> nth=0"), "63");
  await page.click(".us-ambient-panel .us-ap-num >> nth=0");
  await page.keyboard.type("40");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.sync.get("settings")).settings.ambientStrength)) === 40);
  assert.equal(await page.evaluate(() => document.querySelector("#movie_player video").paused), false, "клики в панели не ставят видео на паузу");
  await page.mouse.click(5, 5);
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-ambient-panel")));

  // Во время рекламы её цвета не светим.
  await page.evaluate(() => document.querySelector("#movie_player").classList.add("ad-showing"));
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-ambient.us-show")));
  await page.evaluate(() => document.querySelector("#movie_player").classList.remove("ad-showing"));

  await setSettings({ ambient: false, ambientStrength: 70 });
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-ambient")));
  assert.equal(await page.evaluate(() => document.querySelector(".us-ambient-btn")), null);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById("cinematics-container")).display), "none");
  await page.close();
});

test("подсветка в YouTube Music: по обложке трека, в шапке, перелив и пульс в такт басам", async () => {
  await setSettings({ ambientMusic: true });
  const page = await context.newPage();
  await page.goto("https://music.youtube.com/ambient");
  await waitFor(() => page.evaluate(() => document.querySelector("ytmusic-player-page > .us-ambient.us-show")));
  // Свечение лежит вокруг коробки плеера, а не внутри неё (там непрозрачный фон).
  const boxes = await page.evaluate(() => [".us-ambient", "ytmusic-player"].map((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(Math.round).join(",");
  }));
  assert.equal(boxes[0], boxes[1]);
  const colors = await page.evaluate(() => {
    const c = document.querySelector(".us-ambient-canvas");
    const px = (x) => [...c.getContext("2d").getImageData(x, 13, 1, 1).data.slice(0, 3)];
    return { left: px(10), right: px(38) };
  });
  assert.ok(colors.left[1] > 150 && colors.left[0] < 80, `слева зелёный: ${colors.left}`);
  assert.ok(colors.right[0] > 200 && colors.right[1] > 160, `справа жёлтый: ${colors.right}`);
  assert.ok(await page.evaluate(() => document.querySelector("ytmusic-nav-bar > .us-ambient-header.us-show")));

  // Трек играет: обложка медленно поворачивается, а на ударах свечение вспыхивает.
  await page.mouse.click(700, 40);
  await page.evaluate(() => playBeat());
  const snapshot = () => page.evaluate(() => document.querySelector(".us-ambient-canvas").toDataURL());
  const before = await snapshot();
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    peak = Math.max(peak, await page.evaluate(() => Number(document.querySelector(".us-ambient").style.getPropertyValue("--us-pulse")) || 0));
    await sleep(50);
  }
  assert.ok(peak > 0.3, `пульс на ударах: ${peak}`);
  assert.notEqual(await snapshot(), before, "обложка переливается");
  assert.ok(await page.evaluate(() => {
    const v = document.querySelector("ytmusic-player video");
    return !v.paused && v.currentTime > 1;
  }), "звук продолжает играть");

  // Панель в YouTube Music — у кнопки в нижней панели плеера, с переключателем «В такт музыке».
  await page.click("ytmusic-player-bar .us-ambient-btn");
  assert.ok(await page.isVisible("body > .us-ambient-panel"));
  await page.click(".us-ambient-panel .us-ap-toggle");
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.sync.get("settings")).settings.musicPulse)) === false);
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-ambient.us-pulsing")));
  await page.keyboard.press("Escape");
  await setSettings({ ambientMusic: false, musicPulse: true });
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-ambient")));
  await page.close();
});

test("оригинальная дорожка: дубляж и ИИ-озвучка сменяются оригиналом, ручной выбор потом не трогаем", async () => {
  const page = await openYouTube();
  await waitFor(() => page.evaluate(() => yt.audioTrack === yt.tracks.original));
  assert.equal(await page.evaluate(() => yt.audioSwitches), 1);
  // YouTube сам вернул дубляж через несколько секунд — снова ставим оригинал.
  await page.evaluate(() => (yt.audioTrack = yt.tracks.dub));
  await waitFor(() => page.evaluate(() => yt.audioTrack === yt.tracks.original));
  // Пользователь сам выбрал немецкий в меню плеера — оставляем.
  await page.evaluate(() => {
    const player = document.querySelector("#movie_player");
    const menu = document.createElement("div");
    menu.className = "ytp-popup ytp-settings-menu";
    player.append(menu);
    menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    player.setAudioTrack(yt.tracks.german);
  });
  await sleep(2500);
  assert.equal(await page.evaluate(() => yt.audioTrack === yt.tracks.german), true);
  await page.close();

  await setSettings({ ytOriginalAudio: false });
  const off = await openYouTube();
  await sleep(1500);
  assert.equal(await off.evaluate(() => yt.audioSwitches), 0, "по настройке выключено");
  await off.close();
  await setSettings({ ytOriginalAudio: true });
});

test("звук: усиление, выравнивание, ночной режим и эквалайзер, панель в плеере", async () => {
  const page = await openYouTube();
  const audio = () => page.evaluate(() => JSON.parse(document.documentElement.dataset.usAudio || "null"));
  await page.evaluate(() => (yt.loudness = -6));
  await sleep(700);
  assert.equal(await page.evaluate(() => document.querySelector(".us-audio-btn")), null, "пока всё выключено, кнопки нет");
  assert.equal(await audio(), null, "и звук не трогаем");

  await setSettings({ audioBoostOn: true, audioBoost: 200, audioNormalize: true, audioNight: true, audioEq: true, audioEqPreset: "bass" });
  await page.mouse.click(880, 540);
  await waitFor(async () => (await audio())?.gain === 3.99);
  const state = await audio();
  assert.equal(state.state, "running");
  assert.equal(state.night, true);
  assert.deepEqual(state.eq, [7, 4, 0, 0, 1]);
  assert.equal(await page.evaluate(() => document.querySelector("#movie_player video").paused), false);

  // Рекламу не усиливаем (команду пропуска плеер здесь игнорирует, чтобы реклама продержалась).
  await page.evaluate(() => {
    yt.noApi = true;
    document.querySelector("#movie_player").classList.add("ad-showing");
  });
  await waitFor(async () => (await audio()).gain === 1);
  await page.evaluate(() => {
    yt.noApi = false;
    document.querySelector("#movie_player").classList.remove("ad-showing");
  });
  await waitFor(async () => (await audio()).gain === 3.99);

  // Панель «Звук»: громкость, готовая настройка и своя полоса эквалайзера.
  await page.click(".ytp-right-controls-left > .us-audio-btn");
  assert.ok(await page.isVisible("#movie_player > .us-audio-panel"));
  assert.match(await page.textContent(".us-audio-panel .us-ap-note"), /6 дБ/);
  await page.fill(".us-audio-panel .us-ap-range", "300");
  await waitFor(async () => (await audio()).gain === 5.99);
  await page.click('.us-audio-panel .us-eq-preset[data-preset="voice"]');
  await waitFor(async () => JSON.stringify((await audio()).eq) === "[-4,-1,3,4,1]");
  await page.fill(".us-audio-panel .us-eq-band >> nth=0", "10");
  await waitFor(async () => (await audio()).eq[0] === 10);
  // Полосу можно задать числом: лишнее прижимается к ±12 дБ, клавиши-цифры не перематывают видео.
  const time = await page.evaluate(() => document.querySelector("#movie_player video").currentTime);
  await page.click(".us-audio-panel .us-eq-col .us-ap-num >> nth=1");
  await page.keyboard.type("-25");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await audio()).eq[1] === -12);
  assert.equal(await page.inputValue(".us-audio-panel .us-eq-col .us-ap-num >> nth=1"), "-12");
  assert.ok(await page.evaluate((t) => Math.abs(document.querySelector("#movie_player video").currentTime - t) < 3, time));
  await waitFor(async () => {
    const s = await worker.evaluate(async () => (await chrome.storage.sync.get("settings")).settings);
    return s.audioBoost === 300 && s.audioEqPreset === "custom" && s.audioEqBands[0] === 10 && s.audioEqBands[1] === -12;
  });
  // Открытие подсветки закрывает панель звука.
  await setSettings({ ambient: true });
  await page.click(".ytp-right-controls-left > .us-ambient-btn");
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-audio-panel") && document.querySelector(".us-ambient-panel")));
  await page.keyboard.press("Escape");
  // Кнопки звука и подсветки стоят на месте и не переставляют друг друга (раньше из-за этого мигали).
  const moves = await page.evaluate(() => new Promise((resolve) => {
    let count = 0;
    const observer = new MutationObserver((records) => {
      count += records.filter((r) => [...r.addedNodes].some((n) => n.classList?.contains("us-player-btn"))).length;
    });
    observer.observe(document.querySelector(".ytp-right-controls"), { childList: true, subtree: true });
    setTimeout(() => resolve(count), 1500);
  }));
  assert.equal(moves, 0);

  await setSettings({ ambient: false, audioBoostOn: false, audioBoost: 150, audioNormalize: false, audioNight: false, audioEq: false, audioEqPreset: "voice", audioEqBands: [0, 0, 0, 0, 0] });
  await waitFor(async () => (await audio()).on === false && (await audio()).gain === 1);
  await waitFor(() => page.evaluate(() => !document.querySelector(".us-audio-btn")));
  await page.close();
});

test("YouTube Music: реклама тоже пропускается", async () => {
  const page = await context.newPage();
  await page.goto(`https://music.youtube.com/watch?v=${VIDEO_ID}`);
  await page.evaluate(() => yt.ready);
  await page.evaluate(() => yt.startAd());
  await waitFor(() => page.evaluate(() => yt.apiSkips === 1), { timeout: 3000 });
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

  await popup.click('[data-tab="view"]');
  assert.equal(await popup.isVisible('[data-panel="view"]'), true);
  assert.equal(await popup.isVisible('[data-panel="overview"]'), false);
  await popup.click('label:has([data-setting="ytHideShorts"])');
  await popup.click('[data-tab="segments"]');
  await popup.click('.modes button[data-category="intro"][data-mode="auto"]');
  await popup.click('[data-tab="player"]');
  await popup.selectOption('[data-setting-select="ytQuality"]', "hd720");
  await popup.selectOption('[data-setting-select="ytSpeed"]', "1.25");
  const saved = await worker.evaluate(async () => (await chrome.storage.sync.get("settings")).settings);
  assert.equal(saved.ytHideShorts, true);
  assert.equal(saved.sbModes.intro, "auto");
  assert.equal(saved.ytQuality, "hd720");
  assert.equal(saved.ytSpeed, 1.25);
  await waitFor(() => yt.evaluate(() => yt.quality === "hd720" && document.querySelector("video").playbackRate === 1.25));

  // Скорость для канала задаётся прямо из «Обзора» и важнее общей.
  await popup.click('[data-tab="overview"]');
  await popup.click('.channel .choice button:has-text("2×")');
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.local.get("channelSpeeds")).channelSpeeds?.UC_TEST?.rate)) === 2);
  await waitFor(() => yt.evaluate(() => document.querySelector("video").playbackRate === 2));
  await popup.click('.channel .choice button:has-text("Обычная")');
  await waitFor(() => yt.evaluate(() => document.querySelector("video").playbackRate === 1.25));

  // Быстрые переключатели в «Обзоре».
  await popup.click('.quick-tile[data-key="ytDislikes"]');
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.sync.get("settings")).settings.ytDislikes)) === false);
  assert.equal(await popup.getAttribute('.quick-tile[data-key="ytDislikes"]', "aria-pressed"), "false");
  await popup.click('.quick-tile[data-key="ytDislikes"]');

  await popup.click('.power');
  assert.equal(await popup.evaluate(() => document.body.classList.contains("off")), true);
  await waitFor(() => yt.evaluate(() => !document.querySelector(".us-bar")));
  await popup.click('.power');

  await setSettings({ ytHideShorts: false, ytQuality: "auto", ytSpeed: null, sbModes: await worker.evaluate(() => US.DEFAULTS.sbModes) });
  await yt.close();
  await popup.close();
});
