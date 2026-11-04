importScripts("shared/defaults.js");

const API = "https://sponsor.ajay.app/api";
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await US.getSettings();
  await chrome.storage.sync.set({ settings });
  chrome.action.setBadgeBackgroundColor({ color: "#7c5cff" });
});

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Запрос по 4-символьному префиксу хэша: сервер SponsorBlock не узнаёт, какое видео смотрят.
async function fetchSegments(videoId, categories) {
  const key = videoId + "|" + [...categories].sort().join(",");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.segments;

  const prefix = (await sha256Hex(videoId)).slice(0, 4);
  const params = new URLSearchParams({
    categories: JSON.stringify(categories),
    actionTypes: JSON.stringify(["skip"]),
  });
  const res = await fetch(`${API}/skipSegments/${prefix}?${params}`);
  let segments = [];
  if (res.ok) {
    const videos = await res.json();
    const video = videos.find((v) => v.videoID === videoId);
    segments = (video?.segments ?? [])
      .filter((s) => s.actionType === "skip" && s.segment[1] > s.segment[0])
      .map((s) => ({ uuid: s.UUID, category: s.category, start: s.segment[0], end: s.segment[1] }))
      .sort((a, b) => a.start - b.start);
  } else if (res.status !== 404) {
    throw new Error(`SponsorBlock API: HTTP ${res.status}`);
  }
  cache.set(key, { time: Date.now(), segments });
  return segments;
}

const today = () => new Date().toLocaleDateString("sv");
const emptyStats = () => ({ ads: 0, adSec: 0, segs: 0, segSec: 0, intros: 0 });

let statsQueue = Promise.resolve();
function addStat(delta) {
  statsQueue = statsQueue.then(async () => {
    const { stats = { total: emptyStats(), days: {} } } = await chrome.storage.local.get("stats");
    const day = (stats.days[today()] ??= emptyStats());
    for (const bucket of [stats.total, day]) {
      for (const [k, v] of Object.entries(delta)) bucket[k] = (bucket[k] ?? 0) + v;
    }
    const keep = Object.keys(stats.days).sort().slice(-30);
    stats.days = Object.fromEntries(keep.map((d) => [d, stats.days[d]]));
    await chrome.storage.local.set({ stats });
  });
  return statsQueue;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  switch (msg.type) {
    case "segments":
      fetchSegments(msg.videoId, msg.categories)
        .then((segments) => {
          if (tabId != null && sender.frameId === 0) {
            chrome.action.setBadgeText({ tabId, text: segments.length ? String(segments.length) : "" });
          }
          reply({ segments });
        })
        .catch((e) => reply({ error: String(e.message ?? e) }));
      return true;

    case "stat":
      addStat(msg.delta).then(() => reply({ ok: true }));
      return true;

    // Сообщаем SponsorBlock о пропуске — так авторы сегментов видят, что их работа полезна.
    case "viewed":
      fetch(`${API}/viewedVideoSponsorTime?UUID=${encodeURIComponent(msg.uuid)}`, { method: "POST" }).catch(() => {});
      return false;

    case "clearBadge":
      if (tabId != null && sender.frameId === 0) chrome.action.setBadgeText({ tabId, text: "" });
      return false;
  }
});
