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

  function applyClasses() {
    root.classList.toggle("us-hide-promos", settings.enabled && settings.ytHidePromos);
    root.classList.toggle("us-hide-shorts", settings.enabled && settings.ytHideShorts);
    root.classList.toggle("us-ad-cloak", settings.enabled && settings.ytSpeedAds);
  }
  applyClasses();

  US.getSettings().then((s) => {
    settings = s;
    applyClasses();
    loadSegments();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    const prev = settings;
    settings = US.merge(changes.settings.newValue);
    applyClasses();
    if (!settings.enabled && ad) finishAd(getVideo(getPlayer()));
    const sbChanged =
      prev.enabled !== settings.enabled ||
      prev.sbEnabled !== settings.sbEnabled ||
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
    renderBar();
    hideToast();
    const categories = US.activeCategories(settings);
    if (!videoId || !sbActive() || !categories.length) {
      if (window === top) send({ type: "clearBadge" });
      return;
    }
    const res = await send({ type: "segments", videoId, categories });
    if (token !== loadToken) return;
    segments = (res?.segments ?? []).map((s) => ({ ...s, done: false, undone: false, prompted: false }));
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
    if (!player || !sbActive() || !settings.sbBar || !segments.length) {
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
    for (const seg of segments) {
      const mark = document.createElement("div");
      mark.className = "us-bar-seg";
      mark.style.left = `${(seg.start / duration) * 100}%`;
      mark.style.width = `${((Math.min(seg.end, duration) - seg.start) / duration) * 100}%`;
      mark.style.background = mark.style.color = US.CATEGORIES[seg.category]?.color ?? "#fff";
      mark.classList.toggle("us-hover", segments.indexOf(seg) === hoverIndex);
      bar.append(mark);
    }
    host.append(bar);
  }

  function ensureBar(player, video) {
    bindHover(player);
    if (!segments.length || !settings.sbBar || !sbActive()) return;
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

  // ---------- Главный цикл ----------

  let observedPlayer = null;
  const playerObserver = new MutationObserver(() => tick());

  function tick() {
    if (!alive()) return;
    if (currentVideoId() !== videoId) loadSegments();

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
    checkSegments();
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
          duration: getVideo(player)?.duration || 0,
          adShowing: Boolean(player && isAdShowing(player)),
          segments: segments.map((s) => ({ category: s.category, start: s.start, end: s.end, done: s.done, mode: modeOf(s) })),
        });
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
