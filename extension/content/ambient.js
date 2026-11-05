// Подсветка вокруг видео (как Ambient light) для YouTube и YouTube Music.
// Кадр рисуется в крошечный canvas, а CSS растягивает и размывает его: вокруг плеера, в чёрных полосах
// внутри плеера и в шапке. Пиксели не читаем, поэтому работает и с обложками треков с другого домена.
// Яркость и размер настраиваются кнопкой прямо в плеере; в YouTube Music без клипа светит обложка,
// медленно переливаясь и вспыхивая в такт басам.
(() => {
  if (window.__ultraAmbient || window !== top) return;
  window.__ultraAmbient = true;

  const MUSIC = location.hostname === "music.youtube.com";
  const FRAME_MS = 1000 / 15;
  const W = 48;
  const H = 27;
  const KEYS = MUSIC
    ? { on: "ambientMusic", strength: "musicStrength", size: "musicSize" }
    : { on: "ambient", strength: "ambientStrength", size: "ambientSize" };
  let settings = US.merge();

  const on = () => Boolean(settings.enabled && settings[KEYS.on]);

  // ---------- Слои ----------

  function canvas(className, width, height) {
    const node = document.createElement("canvas");
    node.className = className;
    node.width = width;
    node.height = height;
    return node;
  }

  function layer(className) {
    const node = document.createElement("div");
    node.className = className;
    const c = canvas("us-ambient-canvas", W, H);
    node.append(c);
    return [node, c.getContext("2d")];
  }

  const [glow, glowCtx] = layer(MUSIC ? "us-ambient us-ambient-music" : "us-ambient");
  const [fill, fillCtx] = layer("us-ambient-fill");
  const header = canvas("us-ambient-header", 64, 6);
  const headerCtx = header.getContext("2d");
  const layers = [glow, fill, header];

  function tune() {
    const strength = settings[KEYS.strength] / 100;
    const size = settings[KEYS.size] / 100;
    for (const node of layers) {
      node.style.setProperty("--us-glow-opacity", (0.2 + strength * 0.8).toFixed(2));
      node.style.setProperty("--us-glow-scale", (1.05 + size * 0.6).toFixed(2));
      node.style.setProperty("--us-glow-blur", `${Math.round(30 + size * 80)}px`);
    }
  }

  function apply() {
    document.documentElement.classList.toggle("us-ambient-on", on());
    tune();
    syncPanel();
    if (on()) start();
  }

  US.getSettings().then((s) => {
    settings = s;
    apply();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    settings = US.merge(changes.settings.newValue);
    apply();
  });

  // ---------- Где светить и чем ----------

  function findPlayer() {
    if (MUSIC) {
      const player = document.querySelector("ytmusic-player#player");
      return player?.hasAttribute("player-page-open") && player.offsetWidth ? player : null;
    }
    if (location.pathname !== "/watch") return null;
    const host = document.querySelector("#movie_player")?.closest("#player-full-bleed-container, ytd-watch-flexy #player");
    return host?.offsetWidth ? host : null;
  }

  // В YouTube Music в режиме «Трек» видео скрыто и показана обложка — светим ею.
  function findSource(host) {
    const movie = host.querySelector("#movie_player");
    if (movie?.classList.contains("ad-showing")) return null;
    const video = host.querySelector("video");
    const ready = video?.readyState >= 2 && video.videoWidth;
    if (!MUSIC) return ready ? { kind: "video", el: video, movie } : null;
    if (host.hasAttribute("video-mode") && ready) return { kind: "video", el: video, movie };
    const img = host.querySelector("#song-image img");
    return img?.complete && img.naturalWidth > 1 ? { kind: "cover", el: img, video } : null;
  }

  // Чёрные полосы внутри плеера: видео уже, чем коробка плеера (полный экран, 4:3, вертикальные, YouTube Music).
  function hasBars(movie, video) {
    const outer = movie.getBoundingClientRect();
    const inner = video.getBoundingClientRect();
    return outer.width - inner.width > 8 || outer.height - inner.height > 8;
  }

  function placeGlow(host) {
    if (!MUSIC) {
      if (glow.parentElement !== host) host.prepend(glow);
      return;
    }
    // В YouTube Music коробка плеера непрозрачная и обрезает содержимое — кладём свечение рядом, в страницу плеера.
    const page = host.closest("ytmusic-player-page") ?? host.parentElement;
    if (glow.parentElement !== page) page.prepend(glow);
    const a = host.getBoundingClientRect();
    const b = page.getBoundingClientRect();
    const box = `${Math.round(a.left - b.left + page.scrollLeft)}|${Math.round(a.top - b.top + page.scrollTop)}|${Math.round(a.width)}|${Math.round(a.height)}`;
    if (glow.dataset.box === box) return;
    glow.dataset.box = box;
    const [left, top, width, height] = box.split("|");
    Object.assign(glow.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  }

  // ---------- Обложка: перелив и пульс в такт ----------

  let angle = 0;
  let lastCover = 0;
  let pulse = 0;
  let bassMean = 0.5;
  const audio = { ctx: null, analyser: null, data: null, video: null, failed: false, busy: false, armed: false };

  function drawCover(img) {
    const d = Math.hypot(W, H) * 1.05;
    glowCtx.save();
    glowCtx.translate(W / 2, H / 2);
    glowCtx.rotate(angle);
    glowCtx.drawImage(img, -d / 2, -d / 2, d, d);
    glowCtx.restore();
  }

  // Звук пропускаем через Web Audio только после того, как пользователь хоть раз нажал на странице:
  // без этого Chrome держит AudioContext на паузе, и подключённое к нему видео замолчало бы.
  function armGesture() {
    if (audio.armed) return;
    audio.armed = true;
    const retry = () => {
      audio.armed = false;
      window.removeEventListener("pointerdown", retry, true);
      window.removeEventListener("keydown", retry, true);
      if (audio.video) connectAudio(audio.video);
    };
    window.addEventListener("pointerdown", retry, true);
    window.addEventListener("keydown", retry, true);
  }

  async function connectAudio(video) {
    if (audio.analyser || audio.failed || audio.busy) return;
    audio.video = video;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return armGesture();
    audio.busy = true;
    try {
      audio.ctx ??= new AudioContext();
      const ctx = audio.ctx;
      const running = ctx.state === "running"
        || await Promise.race([ctx.resume().then(() => true), new Promise((r) => setTimeout(r, 500, false))]);
      if (!running || ctx.state !== "running") return armGesture();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      ctx.createMediaElementSource(video).connect(analyser);
      analyser.connect(ctx.destination);
      audio.analyser = analyser;
      audio.data = new Uint8Array(analyser.frequencyBinCount);
      ctx.addEventListener("statechange", () => {
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
      });
    } catch {
      // Видео уже подключено к другому AudioContext (например, другим расширением) — без пульса.
      audio.failed = true;
    } finally {
      audio.busy = false;
    }
  }

  // Басы (примерно 90–380 Гц) против их скользящего среднего: удар бочки — вспышка, затем плавное затухание.
  function readPulse(dt) {
    if (!audio.analyser) return 0;
    audio.analyser.getByteFrequencyData(audio.data);
    const bass = (audio.data[1] + audio.data[2] + audio.data[3] + audio.data[4]) / (4 * 255);
    bassMean += (bass - bassMean) * Math.min(1, dt * 1.5);
    const hit = Math.min(1, Math.max(0, (bass - bassMean) * 5));
    return Math.max(hit, pulse * Math.exp(-dt * 5));
  }

  function setPulse(value) {
    if (Math.abs(value - pulse) < 0.004 && value !== 0) return;
    pulse = value;
    glow.style.setProperty("--us-pulse", pulse.toFixed(3));
  }

  // ---------- Цикл ----------

  let running = false;
  let lastDraw = 0;
  let lastTime = 0;
  let lastKey = "";
  let lastUi = 0;

  function hide() {
    for (const node of layers) node.classList.remove("us-show");
  }

  function stop() {
    running = false;
    for (const node of layers) node.remove();
    hide();
    removeButton();
  }

  function frame(now) {
    if (!on()) return stop();
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(0.1, (now - (lastTime || now)) / 1000);
    lastTime = now;
    if (now - lastUi > 500) {
      lastUi = now;
      ensureButton();
    }

    const host = findPlayer();
    const src = host && findSource(host);
    const pulsing = MUSIC && src?.kind === "cover" && settings.musicPulse && src.video && !src.video.paused;
    glow.classList.toggle("us-pulsing", Boolean(pulsing));
    if (pulsing) {
      connectAudio(src.video);
      setPulse(readPulse(dt));
    } else if (pulse) {
      setPulse(0);
    }

    if (now - lastDraw < FRAME_MS) return;
    lastDraw = now;
    if (!src) return hide();
    placeGlow(host);

    let key;
    if (src.kind === "video") {
      key = `${src.el.currentSrc}|${src.el.currentTime}`;
    } else {
      const playing = src.video && !src.video.paused;
      if (playing) angle += (now - (lastCover || now)) / 1000 * (0.12 + pulse * 0.5);
      lastCover = now;
      key = `${src.el.currentSrc}|${angle.toFixed(4)}`;
    }
    if (key !== lastKey) {
      lastKey = key;
      try {
        if (src.kind === "video") glowCtx.drawImage(src.el, 0, 0, W, H);
        else drawCover(src.el);
      } catch {
        return;
      }
      fillCtx.drawImage(glowCtx.canvas, 0, 0);
      headerCtx.drawImage(glowCtx.canvas, 0, 0, W, 8, 0, 0, header.width, header.height);
    }
    glow.classList.add("us-show");

    const bars = src.kind === "video" && src.movie && hasBars(src.movie, src.el);
    if (bars) {
      if (fill.parentElement !== src.movie) src.movie.prepend(fill);
      fill.classList.add("us-show");
    } else {
      fill.classList.remove("us-show");
    }

    const headerHost = settings.ambientHeader
      ? document.querySelector(MUSIC ? "ytmusic-nav-bar" : "ytd-masthead #background")
      : null;
    if (headerHost) {
      if (header.parentElement !== headerHost) headerHost.prepend(header);
      header.classList.add("us-show");
    } else {
      header.remove();
    }
  }

  function start() {
    if (running) return;
    running = true;
    lastKey = "";
    lastTime = 0;
    requestAnimationFrame(frame);
  }

  // ---------- Кнопка и панель настройки в плеере ----------

  const SVG = "http://www.w3.org/2000/svg";
  function icon() {
    const node = document.createElementNS(SVG, "svg");
    node.setAttribute("viewBox", "0 0 24 24");
    node.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    // Экран с лучами света вокруг.
    path.setAttribute("d", "M7 8h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm4.25-6h1.5v3h-1.5V2Zm0 17h1.5v3h-1.5v-3ZM2 11.25h2.5v1.5H2v-1.5Zm17.5 0H22v1.5h-2.5v-1.5ZM4.4 5.46l1.06-1.06 1.77 1.77-1.06 1.06L4.4 5.46Zm12.37 12.37 1.06-1.06 1.77 1.77-1.06 1.06-1.77-1.77Zm1.06-13.43 1.06 1.06-1.77 1.77-1.06-1.06 1.77-1.77ZM5.46 19.6 4.4 18.54l1.77-1.77 1.06 1.06-1.77 1.77Z");
    node.append(path);
    return node;
  }

  function el(tag, className, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.append(...children);
    return node;
  }

  const button = el("button", MUSIC ? "us-ambient-btn us-music" : "ytp-button us-ambient-btn", icon());
  button.type = "button";
  button.title = "Подсветка UltraTube";
  button.setAttribute("aria-label", "Настроить подсветку");
  button.setAttribute("aria-haspopup", "dialog");

  function slider(key, label) {
    const input = el("input", "us-ap-range");
    Object.assign(input, { type: "range", min: 0, max: 100, step: 5 });
    input.dataset.key = key;
    input.setAttribute("aria-label", label);
    const output = el("output", "");
    const row = el("div", "us-ap-row", el("div", "us-ap-label", el("span", "", label), output), input);
    input.addEventListener("input", () => {
      settings[key] = Number(input.value);
      tune();
      syncPanel();
      saveSoon();
    });
    return row;
  }

  const pulseToggle = el("input", "us-ap-switch");
  pulseToggle.type = "checkbox";
  pulseToggle.addEventListener("change", () => {
    settings.musicPulse = pulseToggle.checked;
    saveSoon();
  });

  const panel = el("div", `us-ambient-panel${MUSIC ? " us-music" : ""}`,
    el("div", "us-ap-head", el("b", "", "Подсветка"), el("span", "", "UltraTube")),
    slider(KEYS.strength, "Яркость"),
    slider(KEYS.size, "Размер свечения"),
    ...(MUSIC
      ? [el("label", "us-ap-toggle",
        el("span", "", el("b", "", "В такт музыке"), el("small", "", "Обложка переливается и вспыхивает на басах")),
        pulseToggle)]
      : []));
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Подсветка");
  // Клики и клавиши внутри панели не должны ставить видео на паузу или перематывать его.
  for (const type of ["click", "dblclick", "mousedown", "pointerdown", "keydown", "wheel"]) {
    panel.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === "keydown" && e.key === "Escape") closePanel();
    });
  }

  function syncPanel() {
    for (const input of panel.querySelectorAll(".us-ap-range")) {
      const value = settings[input.dataset.key];
      if (document.activeElement !== input) input.value = value;
      input.style.setProperty("--fill", `${value}%`);
      input.previousElementSibling.querySelector("output").textContent = `${value}%`;
    }
    pulseToggle.checked = settings.musicPulse;
  }

  let saveTimer = 0;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const current = await US.getSettings();
      const patch = { [KEYS.strength]: settings[KEYS.strength], [KEYS.size]: settings[KEYS.size], musicPulse: settings.musicPulse };
      await chrome.storage.sync.set({ settings: { ...current, ...patch } });
    }, 300);
  }

  function openPanel() {
    syncPanel();
    if (MUSIC) {
      document.body.append(panel);
      const r = button.getBoundingClientRect();
      panel.style.right = `${Math.max(8, innerWidth - r.right - 8)}px`;
      panel.style.bottom = `${Math.max(8, innerHeight - r.top + 10)}px`;
    } else {
      document.querySelector("#movie_player")?.append(panel);
    }
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
  }

  function closePanel() {
    panel.remove();
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
  }

  function outside(e) {
    if (!panel.contains(e.target) && !button.contains(e.target)) closePanel();
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.isConnected) closePanel();
    else openPanel();
  });

  function ensureButton() {
    // В узком окне YouTube Music прячет часть кнопок панели — тогда встаём просто в правую часть панели.
    const visible = (selector) => [...document.querySelectorAll(selector)].find((node) => node.offsetWidth);
    const host = MUSIC
      ? visible("ytmusic-player-bar .right-controls-buttons") ?? visible("ytmusic-player-bar #right-controls")
      : (location.pathname === "/watch" ? document.querySelector("#movie_player .ytp-right-controls") : null);
    if (!host) return removeButton();
    if (button.parentElement === host) return;
    const anchor = MUSIC ? null : host.querySelector(".ytp-settings-button");
    if (anchor) anchor.before(button);
    else host.prepend(button);
  }

  function removeButton() {
    closePanel();
    button.remove();
  }
})();
