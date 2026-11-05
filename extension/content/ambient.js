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

  // Своя подсветка YouTube («Профессиональное освещение») при нашей скрыта, и её переключатель в меню
  // плеера ничего бы не делал — прячем пункт, чтобы не путал. Выключили нашу — пункт возвращается.
  const isYouTubeLighting = (item) => /освещени|ambient|кинематограф|cinematic/i.test(item.querySelector(".ytp-menuitem-label")?.textContent ?? "")
    || Boolean(item.querySelector(".ytp-menuitem-icon path")?.getAttribute("d")?.startsWith("M12 .5C11.73 .5 11.48"));
  let watchedMenu = null;
  const menuObserver = new MutationObserver(() => syncYouTubeLighting());
  function syncYouTubeLighting() {
    if (MUSIC) return;
    const menu = document.querySelector("#movie_player .ytp-settings-menu");
    if (!menu) return;
    // Меню YouTube перестраивает пункты на лету — следим за ним самим, а не за всей страницей.
    if (watchedMenu !== menu) {
      watchedMenu = menu;
      menuObserver.disconnect();
      menuObserver.observe(menu, { childList: true, subtree: true });
    }
    for (const item of menu.querySelectorAll('.ytp-menuitem[role="menuitemcheckbox"]')) {
      if (isYouTubeLighting(item)) item.classList.toggle("us-yt-hidden", on());
    }
  }

  function apply() {
    document.documentElement.classList.toggle("us-ambient-on", on());
    syncYouTubeLighting();
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
  function drawCover(img) {
    const d = Math.hypot(W, H) * 1.05;
    glowCtx.save();
    glowCtx.translate(W / 2, H / 2);
    glowCtx.rotate(angle);
    glowCtx.drawImage(img, -d / 2, -d / 2, d, d);
    glowCtx.restore();
  }

  // Басы (примерно 90–380 Гц) против их скользящего среднего: удар бочки — вспышка, затем плавное затухание.
  // Анализатор даёт общий звуковой модуль (audio.js): подключить видео к Web Audio можно только один раз.
  let bins = null;
  function readPulse(video, dt) {
    const analyser = window.__usAudio?.analyser(video);
    if (!analyser) return 0;
    bins ??= new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    const bass = (bins[1] + bins[2] + bins[3] + bins[4]) / (4 * 255);
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
    panel.ensure(false);
    syncYouTubeLighting();
  }

  function frame(now) {
    if (!on()) return stop();
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(0.1, (now - (lastTime || now)) / 1000);
    lastTime = now;
    if (now - lastUi > 500) {
      lastUi = now;
      panel.ensure(true);
      syncYouTubeLighting();
    }

    const host = findPlayer();
    const src = host && findSource(host);
    const pulsing = MUSIC && src?.kind === "cover" && settings.musicPulse && src.video && !src.video.paused;
    glow.classList.toggle("us-pulsing", Boolean(pulsing));
    if (pulsing) {
      setPulse(readPulse(src.video, dt));
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

  const save = USUI.saver();
  const strength = USUI.slider({
    label: "Яркость",
    onInput(value) {
      settings[KEYS.strength] = value;
      tune();
      save({ [KEYS.strength]: value });
    },
  });
  const size = USUI.slider({
    label: "Размер свечения",
    onInput(value) {
      settings[KEYS.size] = value;
      tune();
      save({ [KEYS.size]: value });
    },
  });
  const pulseToggle = USUI.toggle({
    label: "В такт музыке",
    hint: "Обложка переливается и вспыхивает на басах",
    onChange(on) {
      settings.musicPulse = on;
      save({ musicPulse: on });
    },
  });

  const panel = USUI.playerPanel({
    name: "ambient",
    title: "Подсветка",
    // Экран с лучами света вокруг.
    iconPath: "M7 8h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm4.25-6h1.5v3h-1.5V2Zm0 17h1.5v3h-1.5v-3ZM2 11.25h2.5v1.5H2v-1.5Zm17.5 0H22v1.5h-2.5v-1.5ZM4.4 5.46l1.06-1.06 1.77 1.77-1.06 1.06L4.4 5.46Zm12.37 12.37 1.06-1.06 1.77 1.77-1.06 1.06-1.77-1.77Zm1.06-13.43 1.06 1.06-1.77 1.77-1.06-1.06 1.77-1.77ZM5.46 19.6 4.4 18.54l1.77-1.77 1.06 1.06-1.77 1.77Z",
    children: [strength.row, size.row, ...(MUSIC ? [pulseToggle.row] : [])],
  });
  panel.onOpen = syncPanel;

  function syncPanel() {
    strength.set(settings[KEYS.strength]);
    size.set(settings[KEYS.size]);
    pulseToggle.input.checked = settings.musicPulse;
  }
})();
