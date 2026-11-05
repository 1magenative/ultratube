// Звук: усиление до 300%, ночной режим (компрессор), выравнивание громкости и эквалайзер.
// Видео подключается к Web Audio один раз и навсегда, поэтому это общий модуль: через него же
// подсветка YouTube Music берёт анализатор для пульса в такт музыке.
// Цепочка: видео → эквалайзер → компрессор ночного режима → усиление → ограничитель → колонки.
(() => {
  if (window.__usAudio || window !== top) return;
  const { MUSIC, el, numberField, slider, toggle, playerPanel, saver } = USUI;
  const root = document.documentElement;
  let settings = US.merge();

  const db = (value) => 10 ** (value / 20);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const featuresOn = () => Boolean(settings.enabled
    && (settings.audioBoostOn || settings.audioNight || settings.audioNormalize || settings.audioEq));

  // ---------- Подключение ----------

  let ctx = null;
  let chain = null;
  let busy = false;
  let armed = false;
  let wantAnalyser = false;
  const failed = new WeakSet();

  const getVideo = () => document.querySelector("#movie_player video") ?? document.querySelector("video");

  // Пока пользователь ни разу не нажал на странице, Chrome держит AudioContext на паузе —
  // подключённое к нему видео замолчало бы. Поэтому ждём первого клика или клавиши.
  function armGesture() {
    if (armed) return;
    armed = true;
    const retry = () => {
      armed = false;
      window.removeEventListener("pointerdown", retry, true);
      window.removeEventListener("keydown", retry, true);
      const video = getVideo();
      if (video && (featuresOn() || wantAnalyser)) connect(video);
    };
    window.addEventListener("pointerdown", retry, true);
    window.addEventListener("keydown", retry, true);
  }

  function node(make, setup) {
    const n = make();
    setup?.(n);
    return n;
  }

  async function connect(video) {
    if (chain?.video === video || failed.has(video) || busy) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return armGesture();
    busy = true;
    try {
      ctx ??= new AudioContext();
      const running = ctx.state === "running"
        || await Promise.race([ctx.resume().then(() => true), new Promise((r) => setTimeout(r, 500, false))]);
      if (!running || ctx.state !== "running") return armGesture();
      const source = ctx.createMediaElementSource(video);
      const eq = US.EQ_BANDS.map((band) => node(() => ctx.createBiquadFilter(), (f) => {
        f.type = band.type;
        f.frequency.value = band.freq;
        f.Q.value = 1.1;
      }));
      const night = node(() => ctx.createDynamicsCompressor(), (c) => {
        c.threshold.value = -34;
        c.knee.value = 18;
        c.ratio.value = 8;
        c.attack.value = 0.004;
        c.release.value = 0.25;
      });
      const makeup = node(() => ctx.createGain(), (g) => (g.gain.value = db(7)));
      const gain = ctx.createGain();
      // Ограничитель: громкость выше 100% не хрипит — пики мягко прижимаются к 0 дБ.
      const limiter = node(() => ctx.createDynamicsCompressor(), (c) => {
        c.threshold.value = -1.5;
        c.knee.value = 0;
        c.ratio.value = 20;
        c.attack.value = 0.002;
        c.release.value = 0.12;
      });
      const analyser = node(() => ctx.createAnalyser(), (a) => {
        a.fftSize = 512;
        a.smoothingTimeConstant = 0.5;
      });
      const silent = node(() => ctx.createGain(), (g) => (g.gain.value = 0));
      analyser.connect(silent).connect(ctx.destination);
      chain = { video, source, eq, night, makeup, gain, limiter, analyser, route: "" };
      ctx.addEventListener("statechange", () => {
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
      });
      update();
    } catch {
      // Видео уже подключено к Web Audio другим расширением (например, усилителем громкости).
      failed.add(video);
    } finally {
      busy = false;
    }
  }

  // ---------- Применение настроек ----------

  function loudnessBoost() {
    const loudness = Number.parseFloat(root.dataset.usLoudness);
    // YouTube сам убавляет слишком громкие ролики, а тихие не трогает — поднимаем их до эталона, до +12 дБ.
    return Number.isFinite(loudness) ? clamp(-loudness, 0, 12) : 0;
  }

  const isAd = () => Boolean(document.querySelector("#movie_player.ad-showing"));

  function eqBands() {
    return settings.audioEqPreset === "custom"
      ? settings.audioEqBands
      : (US.EQ_PRESETS[settings.audioEqPreset]?.bands ?? US.EQ_PRESETS.flat.bands);
  }

  function update() {
    if (!chain) return;
    const on = featuresOn();
    const eqOn = on && settings.audioEq;
    const nightOn = on && settings.audioNight;
    const route = `${on}|${eqOn}|${nightOn}`;
    if (route !== chain.route) {
      chain.route = route;
      const { source, eq, night, makeup, gain, limiter, analyser } = chain;
      for (const n of [source, ...eq, night, makeup, gain, limiter]) n.disconnect();
      source.connect(analyser);
      if (!on) {
        source.connect(ctx.destination);
      } else {
        let last = source;
        if (eqOn) for (const f of eq) last = last.connect(f);
        if (nightOn) last = last.connect(night).connect(makeup);
        last.connect(gain).connect(limiter).connect(ctx.destination);
      }
    }
    const ad = isAd();
    const boost = on && settings.audioBoostOn && !ad ? settings.audioBoost / 100 : 1;
    const level = on && settings.audioNormalize && !ad ? db(loudnessBoost()) : 1;
    chain.gain.gain.setTargetAtTime(boost * level, ctx.currentTime, 0.05);
    const bands = eqBands();
    chain.eq.forEach((f, i) => f.gain.setTargetAtTime(bands[i] ?? 0, ctx.currentTime, 0.05));
    // Состояние цепочки — в атрибуте <html>, чтобы его было видно в отладке и в тестах.
    const state = JSON.stringify({ state: ctx.state, on, night: nightOn, eq: eqOn ? bands : null, gain: Number((boost * level).toFixed(2)) });
    if (root.dataset.usAudio !== state) root.dataset.usAudio = state;
  }

  function tick() {
    const video = getVideo();
    if (video && featuresOn()) connect(video);
    update();
    panel.ensure(featuresOn());
    if (panel.panel.isConnected) sync();
  }

  // ---------- Панель «Звук» в плеере ----------

  const save = saver();

  const boost = slider({
    label: "Громкость",
    min: 100,
    max: 300,
    onInput(value) {
      settings.audioBoost = value;
      settings.audioBoostOn = value > 100;
      save({ audioBoost: value, audioBoostOn: settings.audioBoostOn });
      update();
      sync();
    },
  });
  const night = toggle({
    label: "Ночной режим",
    hint: "Тише взрывы, громче голоса — сильнее, чем у YouTube",
    onChange(on) {
      settings.audioNight = on;
      save({ audioNight: on });
      update();
    },
  });
  const level = toggle({
    label: "Выравнивание громкости",
    hint: "Тихие ролики — до уровня остальных",
    onChange(on) {
      settings.audioNormalize = on;
      save({ audioNormalize: on });
      update();
      sync();
    },
  });
  const eqToggle = toggle({
    label: "Эквалайзер",
    onChange(on) {
      settings.audioEq = on;
      save({ audioEq: on });
      update();
      sync();
    },
  });

  const presets = el("div", "us-eq-presets");
  presets.setAttribute("role", "group");
  presets.setAttribute("aria-label", "Настройка эквалайзера");
  for (const [id, preset] of Object.entries(US.EQ_PRESETS)) {
    const btn = el("button", "us-eq-preset", preset.name);
    btn.type = "button";
    btn.dataset.preset = id;
    btn.addEventListener("click", () => {
      settings.audioEqPreset = id;
      settings.audioEq = true;
      save({ audioEqPreset: id, audioEq: true });
      update();
      sync();
    });
    presets.append(btn);
  }

  // Любая полоса, сдвинутая ползунком или введённая числом, переводит эквалайзер в «Свой».
  function setBand(i, value) {
    const next = [...eqBands()];
    next[i] = value;
    Object.assign(settings, { audioEqBands: next, audioEqPreset: "custom", audioEq: true });
    save({ audioEqBands: next, audioEqPreset: "custom", audioEq: true });
    update();
    sync();
  }

  const bands = el("div", "us-eq-bands");
  const bandInputs = US.EQ_BANDS.map((band, i) => {
    const input = el("input", "us-eq-band");
    Object.assign(input, { type: "range", min: -12, max: 12, step: 1 });
    input.setAttribute("aria-label", `${band.label} Гц`);
    input.addEventListener("input", () => setBand(i, Number(input.value)));
    const field = numberField({ min: -12, max: 12, signed: true, label: `${band.label} Гц, дБ`, onCommit: (v) => setBand(i, v) });
    bands.append(el("div", "us-eq-col", field.input, input, el("span", "", band.label)));
    return { input, field };
  });

  const note = el("p", "us-ap-note");

  const panel = playerPanel({
    name: "audio",
    title: "Звук",
    // Полоски эквалайзера.
    iconPath: "M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z",
    children: [boost.row, night.row, level.row, eqToggle.row, presets, bands, note],
  });
  panel.onOpen = () => {
    // Сама панель открывается кликом — значит, звук уже можно подключать.
    const video = getVideo();
    if (video) connect(video).then(sync);
    sync();
  };

  function sync() {
    boost.set(settings.audioBoostOn ? settings.audioBoost : 100);
    night.input.checked = settings.audioNight;
    level.input.checked = settings.audioNormalize;
    eqToggle.input.checked = settings.audioEq;
    for (const btn of presets.children) btn.setAttribute("aria-pressed", String(btn.dataset.preset === settings.audioEqPreset));
    const values = eqBands();
    bandInputs.forEach(({ input, field }, i) => {
      if (document.activeElement !== input) input.value = values[i];
      field.set(values[i] ?? 0);
    });
    panel.panel.classList.toggle("us-eq-off", !settings.audioEq);

    let text = "";
    const video = getVideo();
    if (video && failed.has(video)) text = "Звук уже обрабатывает другое расширение — UltraTube не может подключиться к нему.";
    else if (chain?.video !== video) text = "Звук подключится после первого клика по странице.";
    else if (settings.audioNormalize && root.dataset.usLoudness) {
      const up = loudnessBoost();
      text = up > 0.5 ? `Этот ролик тише нормы — поднимаем на ${up.toLocaleString("ru", { maximumFractionDigits: 1 })} дБ.` : "Этот ролик и так звучит в норме.";
    }
    note.textContent = text;
    note.hidden = !text;
  }

  // ---------- Запуск ----------

  US.getSettings().then((s) => {
    settings = s;
    tick();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    settings = US.merge(changes.settings.newValue);
    tick();
  });
  setInterval(tick, 500);

  window.__usAudio = {
    // Для пульса подсветки: подключает видео (если ещё нет) и отдаёт анализатор, когда он готов.
    analyser(video) {
      if (chain?.video === video) return chain.analyser;
      wantAnalyser = true;
      connect(video);
      return null;
    },
  };
})();
