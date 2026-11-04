(() => {
  if (window.__ultraSkip) return;
  window.__ultraSkip = true;

  const AD_RATE = 16;
  const TOAST_SECONDS = 5;
  const SKIP_BUTTONS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button-slot button",
    ".ytp-ad-overlay-close-button",
  ].join(",");

  const root = document.documentElement;
  let settings = US.merge();

  const alive = () => Boolean(chrome.runtime?.id);
  const send = (msg) => (alive() ? chrome.runtime.sendMessage(msg).catch(() => null) : Promise.resolve(null));
  const getPlayer = () => document.querySelector("#movie_player, .html5-video-player");
  const getVideo = (player) => player?.querySelector("video") ?? null;
  const isAdShowing = (player) =>
    player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
  const modeOf = (seg) => settings.sbModes[seg.category] ?? "off";
  const sbActive = () => settings.enabled && settings.sbEnabled;

  let channelSpeeds = {};

  function applyClasses() {
    const classes = {
      "us-hide-promos": settings.ytHidePromos,
      "us-hide-shorts": settings.ytHideShorts,
      "us-ad-cloak": settings.ytSpeedAds,
      "us-hide-recs": settings.hideRecs,
      "us-hide-comments": settings.hideComments,
      "us-hide-endcards": settings.hideEndCards,
      "us-hide-home": settings.hideHomeFeed,
      "us-fake-premium": settings.fakePremium,
      "us-fast-speed": settings.ytFastSpeed,
    };
    for (const [name, on] of Object.entries(classes)) root.classList.toggle(name, settings.enabled && on);
    publishConfig();
  }

  // Качество, скорость и «не останавливать» применяет youtube-main.js — только у него есть доступ к API плеера.
  function publishConfig() {
    root.dataset.usConfig = JSON.stringify({
      enabled: settings.enabled,
      quality: settings.ytQuality,
      speed: settings.ytSpeed,
      channelSpeeds: Object.fromEntries(Object.entries(channelSpeeds).map(([id, c]) => [id, c.rate])),
      nonstop: settings.ytNonstop,
      noAutoplay: settings.ytNoAutoplay,
    });
  }
  applyClasses();

  US.getSettings().then((s) => {
    settings = s;
    applyClasses();
    redirectShorts();
    loadSegments();
  });
  chrome.storage.local.get("channelSpeeds").then((data) => {
    channelSpeeds = data.channelSpeeds ?? {};
    publishConfig();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.channelSpeeds) return;
    channelSpeeds = changes.channelSpeeds.newValue ?? {};
    publishConfig();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    const prev = settings;
    settings = US.merge(changes.settings.newValue);
    applyClasses();
    if (!settings.enabled && ad) finishAd(getVideo(getPlayer()));
    if (prev.ytDislikes !== settings.ytDislikes || prev.enabled !== settings.enabled) loadDislikes();
    const sbChanged =
      prev.enabled !== settings.enabled ||
      prev.sbEnabled !== settings.sbEnabled ||
      prev.ytHighlight !== settings.ytHighlight ||
      US.activeCategories(prev).join() !== US.activeCategories(settings).join();
    if (sbChanged) loadSegments();
    else {
      renderBar();
      checkSegments();
    }
  });

  // ---------- Реклама ----------

  let ad = null;
  let userRate = null;

  function adTick(player, video) {
    if (!isAdShowing(player)) {
      if (ad) finishAd(video);
      userRate = video.playbackRate;
      return;
    }

    const now = performance.now();
    if (!ad) {
      ad = { muted: video.muted, rate: userRate, touched: false, count: 1, saved: 0, lastT: video.currentTime, lastD: video.duration, lastWall: now, lastSkip: 0 };
      hideToast();
    } else {
      const realDelta = (now - ad.lastWall) / 1000;
      const mediaDelta = video.currentTime - ad.lastT;
      if (mediaDelta < -0.5) {
        ad.count++;
        addSkippedRest();
      } else if (mediaDelta > realDelta && mediaDelta < 60) {
        ad.saved += mediaDelta - realDelta;
      }
    }
    ad.lastT = video.currentTime;
    ad.lastD = video.duration;
    ad.lastWall = now;

    if (settings.ytSkipAds) requestSkip(player, now);
    // Запасной путь, если команда пропуска не сработала. Перемотку в конец не используем:
    // на живом YouTube она зависает, если реклама ещё не загрузилась, и плеер перезапускает ролик.
    if (settings.ytSpeedAds) {
      ad.touched = true;
      if (!video.muted) video.muted = true;
      if (video.playbackRate !== AD_RATE) video.playbackRate = AD_RATE;
    }
  }

  // Пропуск делает youtube-main.js в мире страницы; повторяем, пока реклама на экране —
  // так ловятся и следующие ролики в блоке, и финальная заставка рекламы.
  const clicked = new WeakSet();
  function requestSkip(player, now) {
    if (now - ad.lastSkip < 400) return;
    ad.lastSkip = now;
    window.dispatchEvent(new CustomEvent("ultraskip:skip-ad"));
    for (const btn of player.querySelectorAll(SKIP_BUTTONS)) {
      if (clicked.has(btn) || btn.offsetParent === null) continue;
      clicked.add(btn);
      btn.click();
    }
  }

  // Если ролик закончился раньше своей длительности — значит, его пропустили: досчитываем остаток.
  function addSkippedRest() {
    if (Number.isFinite(ad.lastD)) ad.saved += Math.max(0, ad.lastD - ad.lastT);
  }

  function finishAd(video) {
    addSkippedRest();
    if (video && ad.touched) {
      video.muted = ad.muted;
      video.playbackRate = ad.rate ?? 1;
    }
    send({ type: "stat", delta: { ads: ad.count, adSec: ad.saved } });
    ad = null;
  }

  // ---------- SponsorBlock ----------

  let videoId;
  let segments = [];
  let highlight = null;
  let loadToken = 0;
  let scheduled = 0;

  function currentVideoId() {
    const url = new URL(location.href);
    const id = url.pathname === "/watch"
      ? url.searchParams.get("v")
      : url.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  async function loadSegments() {
    const token = ++loadToken;
    videoId = currentVideoId();
    segments = [];
    highlight = null;
    renderBar();
    hideToast();
    const categories = sbActive() ? US.activeCategories(settings) : [];
    const wantHighlight = settings.enabled && settings.ytHighlight;
    if (!videoId || (!categories.length && !wantHighlight)) {
      if (window === top) send({ type: "clearBadge" });
      return;
    }
    const res = await send({ type: "segments", videoId, categories, highlight: wantHighlight });
    if (token !== loadToken) return;
    segments = (res?.segments ?? []).map((s) => ({ ...s, done: false, undone: false, prompted: false }));
    if (res?.highlight) highlight = { start: res.highlight.start, source: "sponsorblock" };
    renderBar();
    checkSegments();
  }

  // done — уже пропущен; undone — пользователь вернулся назад, больше не трогаем;
  // prompted — для режима «Кнопка» уже показали предложение пропустить.
  function checkSegments() {
    clearTimeout(scheduled);
    const player = getPlayer();
    const video = getVideo(player);
    if (!video || !segments.length || !sbActive() || isAdShowing(player)) return;

    const t = video.currentTime;
    for (const seg of segments) {
      const inside = t >= seg.start - 0.05 && t < seg.end - 0.3;
      if (t < seg.start - 0.5) seg.done = seg.prompted = false;
      if (!inside && toast?.seg === seg && toast.kind === "prompt") hideToast();
      if (!inside || seg.done || seg.undone) continue;

      const mode = modeOf(seg);
      if (mode === "auto") return skipSegment(video, seg);
      if (mode === "manual" && !seg.prompted) {
        seg.prompted = true;
        showToast(seg, "prompt");
      }
    }

    if (video.paused) return;
    const next = segments.find((s) => !s.done && !s.undone && s.start > t && ["auto", "manual"].includes(modeOf(s)));
    if (!next) return;
    const ms = ((next.start - t) / video.playbackRate) * 1000;
    if (ms < 2000) scheduled = setTimeout(checkSegments, Math.max(0, ms));
  }

  function skipSegment(video, seg) {
    const from = video.currentTime;
    seg.done = true;
    const to = Number.isFinite(video.duration) ? Math.min(seg.end, video.duration) : seg.end;
    video.currentTime = to;
    send({ type: "stat", delta: { segs: 1, segSec: Math.max(0, to - from) } });
    send({ type: "viewed", uuid: seg.uuid });
    if (settings.sbToast) showToast(seg, "skipped");
    else hideToast();
  }

  function undoSkip(seg) {
    seg.undone = true;
    const video = getVideo(getPlayer());
    if (video) video.currentTime = seg.start;
    hideToast();
  }

  const watched = new WeakSet();
  function watchVideo(video) {
    if (watched.has(video)) return;
    watched.add(video);
    for (const ev of ["timeupdate", "seeked", "play", "ratechange", "loadedmetadata"]) {
      video.addEventListener(ev, checkSegments);
    }
    // Каждый новый ролик рекламы сбрасывает скорость на ×1 — возвращаем ×16 сразу, не дожидаясь цикла.
    for (const ev of ["loadstart", "loadedmetadata", "canplay", "playing", "ratechange"]) {
      video.addEventListener(ev, () => {
        const player = getPlayer();
        if (settings.enabled && player && getVideo(player) === video) adTick(player, video);
      });
    }
    video.addEventListener("durationchange", () => {
      tick();
      ensureBar(getPlayer(), video);
    });
  }

  // ---------- Отрезки на полосе прогресса ----------

  function renderBar() {
    const player = getPlayer();
    player?.querySelector(".us-bar")?.remove();
    const showSegments = sbActive() && settings.sbBar && segments.length;
    if (!player || (!showSegments && !highlight)) {
      player?.querySelectorAll(".us-tip, .us-pill-cat").forEach((el) => el.remove());
      hoverIndex = -1;
      return;
    }

    const host = player.querySelector(".ytp-progress-bar");
    const duration = getVideo(player)?.duration;
    if (!host || !Number.isFinite(duration) || !duration) return;

    const bar = document.createElement("div");
    bar.className = "us-bar";
    bar.dataset.duration = duration;
    for (const seg of showSegments ? segments : []) {
      const mark = document.createElement("div");
      mark.className = "us-bar-seg";
      mark.style.left = `${(seg.start / duration) * 100}%`;
      mark.style.width = `${((Math.min(seg.end, duration) - seg.start) / duration) * 100}%`;
      mark.style.background = mark.style.color = US.CATEGORIES[seg.category]?.color ?? "#fff";
      mark.classList.toggle("us-hover", segments.indexOf(seg) === hoverIndex);
      bar.append(mark);
    }
    if (highlight) {
      const poi = document.createElement("div");
      poi.className = "us-bar-poi";
      poi.style.left = `${(highlight.start / duration) * 100}%`;
      bar.append(poi);
    }
    host.append(bar);
  }

  function ensureBar(player, video) {
    bindHover(player);
    if (!(segments.length && settings.sbBar && sbActive()) && !highlight) return;
    // Длительность у YouTube «плавает» на доли секунды — перерисовываем только при заметной разнице.
    const bar = player.querySelector(".us-bar");
    if (!bar || !(Math.abs(Number(bar.dataset.duration) - video.duration) < 1)) renderBar();
  }

  // Категорию дописываем прямо в штатную плашку YouTube со временем; если её нет — показываем свою над тултипом.
  let hoverHost = null;
  let hoverFrame = 0;
  let hoverIndex = -1;
  function bindHover(player) {
    const host = player.querySelector(".ytp-progress-bar");
    if (!host || host === hoverHost) return;
    hoverHost = host;
    host.addEventListener("mousemove", (e) => {
      cancelAnimationFrame(hoverFrame);
      hoverFrame = requestAnimationFrame(() => updateHover(player, host, e.clientX));
    }, { passive: true });
    host.addEventListener("mouseleave", () => {
      cancelAnimationFrame(hoverFrame);
      updateHover(player, host, null);
    });
  }

  function updateHover(player, host, clientX) {
    const duration = getVideo(player)?.duration;
    let index = -1;
    if (clientX != null && segments.length && settings.sbBar && Number.isFinite(duration) && !isAdShowing(player)) {
      const rect = host.getBoundingClientRect();
      const time = ((clientX - rect.left) / rect.width) * duration;
      index = segments.findIndex((s) => time >= s.start && time <= s.end);
    }

    hoverIndex = index;
    player.querySelectorAll(".us-bar-seg").forEach((mark, i) => mark.classList.toggle("us-hover", i === index));
    let tip = player.querySelector(".us-tip");
    let label = player.querySelector(".us-pill-cat");
    if (index < 0) {
      tip?.remove();
      label?.remove();
      return;
    }

    const seg = segments[index];
    const cat = categoryOf(seg);
    const pill = [...player.querySelectorAll(".ytp-tooltip-progress-bar-pill, .ytp-tooltip-bottom-text")]
      .find((el) => el.offsetParent !== null);
    if (pill) {
      tip?.remove();
      if (label?.parentElement !== pill) {
        label?.remove();
        label = h("span", "us-pill-cat", h("span", "us-dot"), h("span"));
        pill.append(label);
      }
      label.children[0].style.background = cat.color;
      label.children[1].textContent = cat.name;
      return;
    }
    label?.remove();

    if (!tip) {
      tip = h("div", "us-tip", h("span", "us-dot"), h("span"), h("span", "us-muted"));
      player.append(tip);
    }
    tip.children[0].style.background = cat.color;
    tip.children[1].textContent = cat.name;
    tip.children[2].textContent = `${US.formatClock(seg.start)}–${US.formatClock(seg.end)}`;

    const playerRect = player.getBoundingClientRect();
    const ytTip = player.querySelector(".ytp-tooltip");
    const ytTipRect = ytTip && getComputedStyle(ytTip).display !== "none" ? ytTip.getBoundingClientRect() : null;
    const anchorTop = ytTipRect?.height ? ytTipRect.top : host.getBoundingClientRect().top;
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(clientX - playerRect.left, half + 8), playerRect.width - half - 8);
    tip.style.left = `${x}px`;
    tip.style.bottom = `${playerRect.bottom - anchorTop + 6}px`;
  }

  // ---------- Уведомление справа снизу ----------

  const SVG = "http://www.w3.org/2000/svg";
  const categoryOf = (seg) => US.CATEGORIES[seg.category] ?? { name: seg.category, color: "#fff" };

  function h(tag, className, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.append(...children);
    return node;
  }

  function svg(viewBox, ...paths) {
    const node = document.createElementNS(SVG, "svg");
    node.setAttribute("viewBox", viewBox);
    node.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of paths) {
      const child = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
      node.append(child);
    }
    return node;
  }

  const logo = () =>
    svg("0 0 24 24",
      ["rect", { x: "1", y: "1", width: "22", height: "22", rx: "6", fill: "currentColor" }],
      ["path", { d: "M6 7.5l5 4.5-5 4.5zM11.5 7.5l5 4.5-5 4.5zM17.5 7.5h1.4v9h-1.4z", fill: "#16161c" }]);

  let toast = null;
  let toastTimer = 0;

  function showToast(seg, kind) {
    const player = getPlayer();
    if (!player) return;
    removeToast();

    const cat = categoryOf(seg);
    const skipped = kind === "skipped";
    const action = h("button", "us-toast-action", skipped ? "Назад (Enter)" : "Пропустить (Enter)");
    const timer = h("span", "us-toast-timer");
    const close = h("button", "us-toast-close", svg("0 0 24 24", ["path", { d: "M6 6l12 12M18 6L6 18" }]));
    close.setAttribute("aria-label", "Закрыть");
    for (const b of [action, close]) b.type = "button";

    const icon = h("span", "us-toast-icon", logo());
    icon.style.color = cat.color;
    const title = h("span", "us-toast-title", skipped ? `Пропущено: ${cat.name}` : cat.name);

    const node = h("div", `us-toast us-toast-${kind}`, icon, title, h("span", "us-toast-sep"), action, timer, close);
    node.setAttribute("role", "status");
    for (const ev of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) {
      node.addEventListener(ev, (e) => e.stopPropagation());
    }

    const run = () => {
      const video = getVideo(getPlayer());
      if (skipped) undoSkip(seg);
      else if (video) skipSegment(video, seg);
    };
    action.addEventListener("click", run);
    close.addEventListener("click", hideToast);

    toast = { node, seg, kind, run };
    player.append(node);
    requestAnimationFrame(() => node.classList.add("us-show"));

    // Для «Пропущено» — 5 секунд на отмену; для «Кнопки» — сколько осталось до конца вставки.
    const until = skipped ? Date.now() + TOAST_SECONDS * 1000 : null;
    const update = () => {
      if (toast?.node !== node) return;
      const video = getVideo(getPlayer());
      const left = skipped
        ? (until - Date.now()) / 1000
        : video ? (seg.end - video.currentTime) / (video.playbackRate || 1) : 0;
      if (left <= 0) return hideToast();
      timer.textContent = `${Math.ceil(left)} с`;
      toastTimer = setTimeout(update, 250);
    };
    update();
  }

  function removeToast() {
    clearTimeout(toastTimer);
    toast?.node.remove();
    toast = null;
  }

  function hideToast() {
    if (!toast) return;
    clearTimeout(toastTimer);
    const { node } = toast;
    toast = null;
    node.classList.remove("us-show");
    setTimeout(() => node.remove(), 250);
  }

  document.addEventListener("keydown", (e) => {
    if (!toast || e.key !== "Enter" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const target = e.composedPath()[0];
    if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toast.run();
  }, true);

  // ---------- «К главному» ----------

  // Если в SponsorBlock нет метки «главное», берём пик графика «самых пересматриваемых» моментов,
  // который YouTube рисует над полосой прогресса. Первые 5% видео не учитываем — там почти всегда всплеск.
  function heatmapPeak(player, duration) {
    const bar = player.querySelector(".ytp-progress-bar")?.getBoundingClientRect();
    if (!bar?.width) return null;
    let best = null;
    for (const chapter of player.querySelectorAll(".ytp-heat-map-chapter")) {
      const d = chapter.querySelector(".ytp-heat-map-path")?.getAttribute("d");
      if (!d) continue;
      const left = parseFloat(chapter.style.left) || 0;
      const width = parseFloat(chapter.style.width) || 0;
      const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const fraction = (left + (nums[i] / 1000) * width) / bar.width;
        const intensity = 100 - nums[i + 1];
        if (fraction < 0.05 || fraction > 0.98) continue;
        if (!best || intensity > best.intensity) best = { fraction, intensity };
      }
    }
    return best && best.intensity > 0 ? { start: best.fraction * duration, source: "heatmap" } : null;
  }

  function ensureHighlight(player, video) {
    const wanted = settings.enabled && settings.ytHighlight;
    if (wanted && (!highlight || highlight.source === "heatmap") && Number.isFinite(video.duration)) {
      const peak = heatmapPeak(player, video.duration);
      if (peak && Math.abs((highlight?.start ?? -10) - peak.start) > 1) {
        highlight = peak;
        renderBar();
      }
    }

    let btn = player.querySelector(".us-highlight-btn");
    const host = player.querySelector(".ytp-right-controls");
    if (!wanted || !highlight || !host || isAdShowing(player)) return btn?.remove();
    if (!btn) {
      btn = h("button", "ytp-button us-highlight-btn",
        svg("0 0 24 24", ["path", { d: "M13 2 4 14h7l-1 8 9-12h-7z" }]),
        h("span", "us-highlight-label", "К главному"));
      btn.type = "button";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        jumpToHighlight();
      });
      host.prepend(btn);
    }
    const title = `К главному — ${US.formatClock(highlight.start)} (${highlight.source === "sponsorblock" ? "SponsorBlock" : "самые пересматриваемые"})`;
    if (btn.title !== title) {
      btn.title = title;
      btn.setAttribute("aria-label", title);
    }
  }

  function jumpToHighlight() {
    const video = getVideo(getPlayer());
    if (!video || !highlight) return false;
    video.currentTime = highlight.start;
    return true;
  }

  // ---------- Дизлайки (Return YouTube Dislike) ----------

  let dislikes = null;
  let dislikeToken = 0;

  async function loadDislikes() {
    const token = ++dislikeToken;
    const id = currentVideoId();
    dislikes = id ? { videoId: id, count: null } : null;
    renderDislikes();
    if (!id || !settings.enabled || !settings.ytDislikes) return;
    const res = await send({ type: "dislikes", videoId: id });
    if (token !== dislikeToken || !res || res.error) return;
    dislikes = { videoId: id, count: res.dislikes, likes: res.likes };
    renderDislikes();
  }

  function renderDislikes() {
    const player = getPlayer();
    const show = settings.enabled && settings.ytDislikes && dislikes?.count != null && dislikes.videoId === currentVideoId();
    for (const btn of document.querySelectorAll("dislike-button-view-model button")) {
      if (player?.contains(btn)) continue;
      let label = btn.querySelector(".us-dislikes");
      if (!show) {
        if (label) {
          label.remove();
          btn.classList.replace("ytSpecButtonShapeNextIconLeading", "ytSpecButtonShapeNextIconButton");
        }
        continue;
      }
      if (!label) {
        // Повторяем разметку кнопки «Нравится»: иконка слева, текст справа.
        label = h("div", "ytSpecButtonShapeNextButtonTextContent us-dislikes");
        const icon = btn.querySelector(".ytSpecButtonShapeNextIcon");
        if (icon) icon.after(label);
        else btn.append(label);
        btn.classList.replace("ytSpecButtonShapeNextIconButton", "ytSpecButtonShapeNextIconLeading");
      }
      const text = US.formatCount(dislikes.count);
      if (label.textContent !== text) label.textContent = text;
    }
  }

  // ---------- «Продолжить просмотр?» ----------

  // Основная защита — в youtube-main.js (window._lact). Если окно всё же появилось, а пользователь
  // ничего не нажимал последние секунды и видео на паузе, подтверждаем сами.
  let lastUserInput = 0;
  for (const ev of ["pointerdown", "keydown"]) {
    addEventListener(ev, (e) => e.isTrusted && (lastUserInput = Date.now()), true);
  }

  function dismissStillWatching(video) {
    if (!settings.enabled || !settings.ytNonstop || Date.now() - lastUserInput < 3000 || !video.paused) return;
    const dialog = [...document.querySelectorAll("ytd-popup-container yt-confirm-dialog-renderer, ytmusic-you-there-renderer")]
      .find((el) => el.offsetParent !== null);
    if (!dialog) return;
    // По приоритету: querySelector со списком вернул бы первый элемент по порядку в документе — обёртку, а не кнопку.
    const button = ["#confirm-button button", ".yt-button-renderer button", "button"]
      .map((sel) => dialog.querySelector(sel))
      .find(Boolean);
    if (!button) return;
    button.click();
    video.play().catch(() => {});
  }

  // ---------- Скорость выше 2× ----------

  // Плеер YouTube зажимает скорость до 2× (3× у него — только для Premium), а <video> держит любую.
  // Поэтому кнопки скорости выше 2× обрабатываем сами и показываем в панели настоящую скорость.
  const RATE_STEP = 0.25;
  const FAST_CHIPS = [2.5, 3, 3.5, 4];
  const fastOn = () => settings.enabled && settings.ytFastSpeed;
  const clampRate = (r) => Math.round(Math.min(US.MAX_RATE, Math.max(0.25, r)) * 100) / 100;

  function setRate(rate) {
    const video = getVideo(getPlayer());
    if (!video) return;
    rate = clampRate(rate);
    root.dataset.usRate = String(rate);
    window.dispatchEvent(new CustomEvent("ultraskip:set-rate"));
    if (video.playbackRate !== rate) video.playbackRate = rate;
    showSpeedBezel(rate);
    syncSpeedPanel();
  }

  let bezelTimer = 0;
  function showSpeedBezel(rate) {
    const player = getPlayer();
    if (!player) return;
    let bezel = player.querySelector(".us-speed-bezel");
    if (!bezel) {
      bezel = h("div", "us-speed-bezel");
      player.append(bezel);
    }
    bezel.textContent = `${rate.toLocaleString("ru")}×`;
    bezel.classList.add("us-show");
    clearTimeout(bezelTimer);
    bezelTimer = setTimeout(() => bezel.classList.remove("us-show"), 900);
  }

  function syncSpeedPanel() {
    const player = getPlayer();
    const video = getVideo(player);
    if (!player || !video) return;
    const rate = video.playbackRate;
    const panel = player.querySelector(".ytp-variable-speed-panel-content");
    let row = panel?.querySelector(".us-speed-chips");
    if (!fastOn()) return row?.remove();

    if (panel && !row) {
      row = h("div", "us-speed-chips", h("span", "us-speed-chips-label", "UltraTube"));
      for (const value of FAST_CHIPS) {
        const btn = h("button", "ytp-button us-speed-chip", value.toLocaleString("ru", { minimumFractionDigits: 1 }));
        btn.type = "button";
        btn.dataset.rate = value;
        row.append(btn);
      }
      const chips = panel.querySelector(".ytp-variable-speed-panel-chips");
      if (chips) chips.after(row);
      else panel.append(row);
    }
    for (const btn of row?.querySelectorAll(".us-speed-chip") ?? []) {
      btn.classList.toggle("us-active", Number(btn.dataset.rate) === rate);
    }
    if (row) growForRow(player, panel, row);
    // Плеер не знает о скоростях выше 2× и не перерисовывает табло, когда «его» скорость не менялась, —
    // поэтому пишем настоящую скорость сами: в панели и в пункте меню.
    const text = `${rate.toFixed(2)}x`;
    for (const el of panel?.querySelectorAll(".ytp-variable-speed-panel-display span, .ytp-speedslider-text") ?? []) {
      if (el.textContent !== text) el.textContent = text;
    }
    const item = [...player.querySelectorAll(".ytp-settings-menu .ytp-menuitem")]
      .find((el) => /скорость|speed/i.test(el.querySelector(".ytp-menuitem-label")?.textContent ?? ""));
    const content = item?.querySelector(".ytp-menuitem-content");
    if (!content) return;
    if (rate === 1 && !content.dataset.usChanged) normalSpeedLabel = content.textContent;
    const label = rate === 1 && normalSpeedLabel ? normalSpeedLabel : String(rate);
    if (rate > 2 || content.dataset.usChanged) {
      if (content.textContent !== label) content.textContent = label;
      content.dataset.usChanged = rate > 2 ? "1" : "";
    }
  }
  let normalSpeedLabel = "";

  // YouTube задаёт меню, панели и блоку скорости фиксированную высоту — прибавляем к ней наш ряд.
  // Меню прижато к низу плеера, поэтому оно растёт вверх.
  function growForRow(player, panel, row) {
    const extra = row.offsetHeight + 14;
    if (!row.offsetHeight) return;
    const menu = panel.closest(".ytp-settings-menu");
    for (const el of [menu, panel.closest(".ytp-panel"), panel]) {
      const height = el?.style.height;
      if (!height || el.dataset.usGrownTo === height) continue;
      const grown = `${parseFloat(height) + extra}px`;
      el.style.height = grown;
      el.dataset.usGrownTo = grown;
    }
  }

  document.addEventListener("click", (e) => {
    if (!fastOn()) return;
    const target = e.target.closest?.(".us-speed-chip, .ytp-variable-speed-panel-preset-button, .ytp-variable-speed-panel-increment-button");
    const video = getVideo(getPlayer());
    if (!target || !video) return;
    const rate = video.playbackRate;
    let next = null;
    if (target.classList.contains("us-speed-chip")) {
      next = Number(target.dataset.rate);
    } else if (target.querySelector(".ytp-variable-speed-panel-premium-upsell-icon") ||
      (rate > 2 && target.classList.contains("ytp-variable-speed-panel-preset-button"))) {
      // Пока видео быстрее 2×, плеер считает, что стоит 2× — и «2,0» у него ничего бы не изменила.
      next = parseFloat(target.textContent.replace(",", "."));
    } else if (target.classList.contains("ytp-variable-speed-panel-increment-button")) {
      const up = target.textContent.trim() === "+";
      if (up && rate >= 2) next = rate + RATE_STEP;
      else if (!up && rate > 2) next = rate - RATE_STEP;
    }
    // Остальное (обычные скорости до 2×) — штатная логика YouTube.
    if (next == null || Number.isNaN(next)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setRate(next);
  }, true);

  // Shift+> и Shift+< — штатные клавиши скорости; выше 2× продолжаем их сами.
  document.addEventListener("keydown", (e) => {
    if (!fastOn() || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code !== "Period" && e.code !== "Comma") return;
    const target = e.composedPath()[0];
    if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) return;
    const video = getVideo(getPlayer());
    if (!video) return;
    const up = e.code === "Period";
    if (up ? video.playbackRate < 2 : video.playbackRate <= 2) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setRate(video.playbackRate + (up ? RATE_STEP : -RATE_STEP));
  }, true);

  // ---------- Shorts в обычном плеере ----------

  const shortsId = (path) => path.match(/^\/shorts\/([\w-]{11})/)?.[1];

  function redirectShorts() {
    if (window !== top || !settings.enabled || !settings.ytShortsAsVideo) return;
    const id = shortsId(location.pathname);
    if (id) location.replace(`/watch?v=${id}`);
  }

  // Переход по ссылке на Shorts перехватываем до того, как YouTube откроет свою ленту Shorts.
  document.addEventListener("click", (e) => {
    if (!settings.enabled || !settings.ytShortsAsVideo || e.button !== 0) return;
    const link = e.target.closest?.('a[href*="/shorts/"]');
    const id = link && shortsId(new URL(link.href, location.href).pathname);
    if (!id) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const url = `/watch?v=${id}`;
    if (e.ctrlKey || e.metaKey) window.open(url, "_blank");
    else location.assign(url);
  }, true);

  // ---------- Главный цикл ----------

  let observedPlayer = null;
  const playerObserver = new MutationObserver(() => tick());

  function tick() {
    if (!alive()) return;
    redirectShorts();
    if (currentVideoId() !== videoId) loadSegments();
    if (currentVideoId() !== (dislikes?.videoId ?? null)) loadDislikes();
    renderDislikes();

    const player = getPlayer();
    const video = getVideo(player);
    if (!player || !video) return;

    if (player !== observedPlayer) {
      observedPlayer = player;
      playerObserver.disconnect();
      playerObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
    }
    watchVideo(video);
    if (settings.enabled) adTick(player, video);
    ensureBar(player, video);
    ensureHighlight(player, video);
    syncSpeedPanel();
    checkSegments();
    dismissStillWatching(video);
  }

  setInterval(tick, 250);

  if (window === top) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg.type === "status") {
        const player = getPlayer();
        reply({
          site: "youtube",
          videoId,
          skipModule: root.dataset.ultraskipMain === "1",
          channel: (() => {
            try {
              return JSON.parse(root.dataset.usChannel || "null");
            } catch {
              return null;
            }
          })(),
          highlight,
          dislikes: dislikes?.count ?? null,
          duration: getVideo(player)?.duration || 0,
          adShowing: Boolean(player && isAdShowing(player)),
          segments: segments.map((s) => ({ category: s.category, start: s.start, end: s.end, done: s.done, mode: modeOf(s) })),
        });
      } else if (msg.type === "highlight") {
        reply({ ok: jumpToHighlight() });
      } else if (msg.type === "seek") {
        const video = getVideo(getPlayer());
        const seg = segments.find((s) => s.start === msg.time);
        if (seg) seg.undone = true;
        if (video) video.currentTime = msg.time;
        reply({ ok: Boolean(video) });
      }
    });
  }
})();
