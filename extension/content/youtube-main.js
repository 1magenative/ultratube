// Работает в мире страницы: только отсюда доступны методы плеера YouTube.
// С content-скриптом общается через атрибуты <html>: data-us-config (настройки) и data-us-channel (канал видео),
// а пропуск рекламы запрашивается событием ultraskip:skip-ad.
(() => {
  if (window.__ultraSkipMain) return;
  window.__ultraSkipMain = true;
  const root = document.documentElement;
  root.dataset.ultraskipMain = "1";

  // ---------- Пропуск рекламы ----------
  // Кнопка «Пропустить» сама по себе лишь вызывает player.onAdUxClicked("skip-button", layoutId),
  // а синтетические клики YouTube игнорирует (проверяет isTrusted) — поэтому вызываем метод напрямую.

  const MAX_IDS = 300;
  const seen = new Set();

  function collect(node, into) {
    const walk = (n, depth) => {
      if (!n || typeof n !== "object" || depth > 60) return;
      for (const [key, value] of Object.entries(n)) {
        if (key === "layoutId" && typeof value === "string") into.add(value);
        else walk(value, depth + 1);
      }
    };
    walk(node, 0);
    return into;
  }

  function remember(data) {
    for (const id of collect(data, new Set())) {
      seen.delete(id);
      seen.add(id);
    }
    while (seen.size > MAX_IDS) seen.delete(seen.values().next().value);
  }

  // Рекламные блоки в середине видео (и при старте не с начала) YouTube догружает отдельными запросами,
  // их layoutId нет в getPlayerResponse(). Поэтому запоминаем идентификаторы из всех ответов страницы.
  const parse = JSON.parse;
  JSON.parse = function (text, ...rest) {
    const result = parse.call(this, text, ...rest);
    if (typeof text === "string" && text.includes('"layoutId"')) {
      try {
        remember(result);
      } catch {}
    }
    return result;
  };
  const json = Response.prototype.json;
  Response.prototype.json = async function () {
    const result = await json.call(this);
    try {
      remember(result);
    } catch {}
    return result;
  };

  window.addEventListener("ultraskip:skip-ad", () => {
    const player = document.querySelector("#movie_player");
    if (typeof player?.onAdUxClicked !== "function") return;
    const ids = new Set(seen);
    try {
      collect(player.getPlayerResponse?.(), ids);
    } catch {}
    // Плеер сам сверяет layoutId с текущей рекламой, чужие идентификаторы ни на что не влияют.
    for (const id of ids) {
      try {
        player.onAdUxClicked("skip-button", id);
      } catch {}
    }
  });

  // ---------- Качество, скорость, автовоспроизведение ----------

  const QUALITY_ORDER = ["highres", "hd2880", "hd2160", "hd1440", "hd1080", "hd720", "large", "medium", "small", "tiny"];
  let config = {};
  let applied = {};

  function readConfig() {
    const prev = config;
    try {
      config = JSON.parse(root.dataset.usConfig || "{}");
    } catch {
      config = {};
    }
    // Меняли качество или скорость в попапе — применяем к текущему видео сразу.
    if (prev.quality !== config.quality) {
      applied.qualityTarget = null;
      applied.qualityUntil = Date.now() + 15000;
    }
    if (prev.speed !== config.speed || JSON.stringify(prev.channelSpeeds) !== JSON.stringify(config.channelSpeeds)) {
      applied.speed = null;
    }
  }
  readConfig();
  new MutationObserver(readConfig).observe(root, { attributes: true, attributeFilter: ["data-us-config"] });

  function pickQuality(levels, wanted) {
    const usable = levels.filter((l) => QUALITY_ORDER.includes(l)).sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b));
    if (!usable.length) return null;
    if (wanted === "max") return usable[0];
    const limit = QUALITY_ORDER.indexOf(wanted);
    return usable.find((l) => QUALITY_ORDER.indexOf(l) >= limit) ?? usable.at(-1);
  }

  function tick() {
    const player = document.querySelector("#movie_player");
    if (typeof player?.getVideoData !== "function") return;
    const videoId = player.getVideoData()?.video_id;
    const details = player.getPlayerResponse?.()?.videoDetails;
    const channel = details?.videoId === videoId && details?.channelId
      ? JSON.stringify({ id: details.channelId, name: details.author, video: videoId })
      : "";
    if (root.dataset.usChannel !== channel) root.dataset.usChannel = channel;

    if (!videoId || !config.enabled || player.classList.contains("ad-showing")) return;
    if (applied.video !== videoId) {
      const now = Date.now();
      applied = { video: videoId, qualityTarget: null, qualityUntil: now + 15000, speed: null, autonavUntil: now + 10000, autonavClick: 0 };
    }

    // Список качеств YouTube отдаёт не сразу целиком — первые 15 секунд пересчитываем цель по актуальному списку.
    if (config.quality && config.quality !== "auto" && Date.now() < applied.qualityUntil) {
      const target = pickQuality(player.getAvailableQualityLevels?.() ?? [], config.quality);
      const preferred = player.getPreferredQuality?.() ?? applied.qualityTarget;
      if (target && (target !== applied.qualityTarget || preferred !== target)) {
        player.setPlaybackQualityRange(target, target);
        applied.qualityTarget = target;
      }
    }

    if (channel) {
      const rate = config.channelSpeeds?.[details.channelId] ?? config.speed;
      if (rate && applied.speed !== rate) {
        player.setPlaybackRate(rate);
        applied.speed = rate;
      }
    }

    // Переключатель автовоспроизведения реагирует на обычный клик. YouTube выставляет его состояние
    // не сразу, поэтому следим первые 10 секунд видео; потом не мешаем включить его вручную.
    if (config.noAutoplay && Date.now() < applied.autonavUntil && Date.now() - applied.autonavClick > 1500) {
      const toggle = player.querySelector(".ytp-autonav-toggle");
      if (toggle?.querySelector('[aria-checked="true"]')) {
        toggle.click();
        applied.autonavClick = Date.now();
      }
    }
  }
  setInterval(tick, 500);

  // «Видео приостановлено. Продолжить просмотр?» YouTube показывает, когда давно не было действий пользователя;
  // время последнего действия плеер берёт из window._lact.
  setInterval(() => {
    if (config.enabled && config.nonstop) window._lact = Date.now();
  }, 20000);
})();
