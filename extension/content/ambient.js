// Подсветка вокруг видео (как Ambient light) для YouTube и YouTube Music.
// Кадр рисуется в крошечный canvas, а CSS растягивает и размывает его за плеером и в шапке —
// пиксели не читаем, поэтому работает и с обложками треков с другого домена.
(() => {
  if (window.__ultraAmbient || window !== top) return;
  window.__ultraAmbient = true;

  const MUSIC = location.hostname === "music.youtube.com";
  const FRAME_MS = 1000 / 15;
  const root = document.documentElement;
  let settings = US.merge();

  const on = () => settings.enabled && (MUSIC ? settings.ambientMusic : settings.ambient);

  function apply() {
    root.classList.toggle("us-ambient-on", on());
    const strength = settings.ambientStrength / 100;
    const size = settings.ambientSize / 100;
    root.style.setProperty("--us-ambient-opacity", (0.25 + strength * 0.75).toFixed(2));
    root.style.setProperty("--us-ambient-scale", (1.1 + size * 0.5).toFixed(2));
    root.style.setProperty("--us-ambient-blur", `${Math.round(40 + size * 60)}px`);
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

  function canvas(className, width, height) {
    const node = document.createElement("canvas");
    node.className = className;
    node.width = width;
    node.height = height;
    return node;
  }

  const glow = document.createElement("div");
  glow.className = "us-ambient";
  const glowCanvas = canvas("us-ambient-canvas", 48, 27);
  glow.append(glowCanvas);
  const header = canvas("us-ambient-header", 64, 6);

  function findPlayer() {
    if (MUSIC) {
      const player = document.querySelector("ytmusic-player#player");
      return player?.offsetWidth ? player : null;
    }
    if (location.pathname !== "/watch") return null;
    const host = document.querySelector("#movie_player")?.closest("#player-full-bleed-container, ytd-watch-flexy #player");
    return host?.offsetWidth ? host : null;
  }

  // В YouTube Music в режиме «Трек» видео скрыто и показана обложка — светим ею.
  function findSource() {
    if (MUSIC) {
      const player = document.querySelector("ytmusic-player#player");
      const video = player?.querySelector("video");
      if (player?.hasAttribute("video-mode") && video?.readyState >= 2 && video.videoWidth) return video;
      const img = player?.querySelector("#song-image img");
      return img?.complete && img.naturalWidth > 1 ? img : null;
    }
    const player = document.querySelector("#movie_player");
    if (!player || player.classList.contains("ad-showing")) return null;
    const video = player.querySelector("video");
    return video?.readyState >= 2 && video.videoWidth ? video : null;
  }

  const sourceSize = (src) => (src instanceof HTMLVideoElement
    ? [src.videoWidth, src.videoHeight]
    : [src.naturalWidth, src.naturalHeight]);

  let running = false;
  let lastDraw = 0;
  let lastKey = "";

  function frame(now) {
    if (!on()) {
      running = false;
      glow.remove();
      header.remove();
      return;
    }
    requestAnimationFrame(frame);
    if (document.hidden || now - lastDraw < FRAME_MS) return;
    lastDraw = now;

    const host = findPlayer();
    const src = host && findSource();
    if (!src) {
      glow.classList.remove("us-show");
      header.classList.remove("us-show");
      return;
    }
    if (glow.parentElement !== host) host.prepend(glow);

    // Пауза и та же картинка — перерисовывать нечего.
    const key = src instanceof HTMLVideoElement ? `${src.currentSrc}|${src.currentTime}` : src.currentSrc;
    if (key !== lastKey) {
      lastKey = key;
      const [w, h] = sourceSize(src);
      try {
        glowCanvas.getContext("2d").drawImage(src, 0, 0, glowCanvas.width, glowCanvas.height);
        if (settings.ambientHeader) {
          header.getContext("2d").drawImage(src, 0, 0, w, h * 0.3, 0, 0, header.width, header.height);
        }
      } catch {
        return;
      }
    }
    glow.classList.add("us-show");

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
    requestAnimationFrame(frame);
  }
})();
