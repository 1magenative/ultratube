const $ = (sel) => document.querySelector(sel);
let settings;
let channelSpeeds = {};
let lastStatus = "";

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- Настройки ----------

function save() {
  chrome.storage.sync.set({ settings });
  renderSettings();
}

function renderSettings() {
  for (const input of document.querySelectorAll("[data-setting]")) {
    input.checked = Boolean(settings[input.dataset.setting]);
  }
  for (const row of document.querySelectorAll("[data-depends]")) {
    row.classList.toggle("disabled", !settings[row.dataset.depends]);
  }
  for (const btn of document.querySelectorAll(".modes button")) {
    btn.setAttribute("aria-pressed", settings.sbModes[btn.dataset.category] === btn.dataset.mode);
  }
  for (const select of document.querySelectorAll("[data-setting-select]")) {
    select.value = String(settings[select.dataset.settingSelect] ?? "");
  }
  for (const tile of document.querySelectorAll(".quick-tile")) {
    const on = Boolean(settings[tile.dataset.key]);
    tile.setAttribute("aria-pressed", on);
    tile.querySelector(".quick-state").textContent = on ? "включено" : "выключено";
  }
  for (const btn of document.querySelectorAll("[data-choice] button")) {
    const key = btn.parentElement.dataset.choice;
    btn.setAttribute("aria-pressed", String(settings[key] ?? "") === btn.dataset.value);
  }
  document.body.classList.toggle("off", !settings.enabled);
  $("#tagline").textContent = settings.enabled ? "Всё лучшее для YouTube" : "На паузе";
}

function buildCategories() {
  const box = $("#categories");
  for (const [id, cat] of Object.entries(US.CATEGORIES)) {
    const modes = el("div", { className: "modes", role: "group", ariaLabel: cat.name });
    for (const [mode, label] of Object.entries(US.MODES)) {
      const btn = el("button", { type: "button" }, label);
      btn.dataset.category = id;
      btn.dataset.mode = mode;
      btn.addEventListener("click", () => {
        settings.sbModes = { ...settings.sbModes, [id]: mode };
        save();
      });
      modes.append(btn);
    }
    box.append(el("div", { className: "cat" },
      el("span", { className: "dot", style: `background:${cat.color}` }),
      el("span", { className: "cat-name" }, cat.name),
      modes));
  }
}

function buildPlayerControls() {
  const quality = document.querySelector('[data-setting-select="ytQuality"]');
  for (const [value, label] of Object.entries(US.QUALITIES)) quality.append(el("option", { value }, label));
  quality.addEventListener("change", () => {
    settings.ytQuality = quality.value;
    save();
  });

  const speed = document.querySelector('[data-setting-select="ytSpeed"]');
  for (const value of [null, ...US.SPEEDS]) {
    speed.append(el("option", { value: value ?? "" }, value == null ? "Не менять" : `${value.toLocaleString("ru")}×`));
  }
  speed.addEventListener("change", () => {
    settings.ytSpeed = speed.value ? Number(speed.value) : null;
    save();
  });
}

const svgIcon = (d) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
};

const QUICK = [
  { key: "ytSkipAds", label: "Реклама", icon: "M5 5l8 7-8 7zM14 5h2.5v14H14z" },
  { key: "sbEnabled", label: "Вставки", icon: "M4 5h16v2.2H4zm0 5.9h10v2.2H4zm0 5.9h16V19H4z" },
  { key: "ytFastSpeed", label: "До 4×", icon: "M13 2 4 14h7l-1 8 9-12h-7z" },
  { key: "ytDislikes", label: "Дизлайки", icon: "M22 3h-4v12h4zM2 14a2 2 0 0 0 2 2h6.3l-1 4.6v.3a1.5 1.5 0 0 0 .5 1l1 1.1 5.6-5.6A2 2 0 0 0 17 16V5a2 2 0 0 0-2-2H6a2 2 0 0 0-1.8 1.2l-3 7.1c-.1.2-.2.5-.2.7z" },
  { key: "ytShortsAsVideo", label: "Shorts → видео", icon: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm2 6v8l6-4z" },
  { key: "fakePremium", label: "Premium‑лого", icon: "M3 7.5l4.5 4 4.5-6.5 4.5 6.5 4.5-4L19 19H5z" },
];

function buildQuick() {
  for (const { key, label, icon } of QUICK) {
    const tile = el("button", { type: "button", className: "quick-tile" },
      el("span", { className: "quick-icon" }, svgIcon(icon)),
      el("span", { className: "quick-label" }, label),
      el("span", { className: "quick-state" }));
    tile.dataset.key = key;
    tile.addEventListener("click", () => {
      settings[key] = !settings[key];
      save();
      refreshNow();
    });
    $("#quick").append(tile);
  }
}

// ---------- Вкладки ----------

function bindTabs() {
  let saved = "overview";
  try {
    saved = localStorage.getItem("us-tab") || saved;
  } catch {}
  const show = (name) => {
    for (const tab of document.querySelectorAll("[data-tab]")) {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", on);
      tab.tabIndex = on ? 0 : -1;
    }
    for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== name;
    try {
      localStorage.setItem("us-tab", name);
    } catch {}
  };
  const tabs = [...document.querySelectorAll("[data-tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => show(tab.dataset.tab));
    tab.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
      next.focus();
      show(next.dataset.tab);
    });
  }
  show(tabs.some((t) => t.dataset.tab === saved) ? saved : "overview");
}

// ---------- Скорость по каналам ----------

async function setChannelSpeed(channel, rate) {
  const next = { ...channelSpeeds };
  if (rate == null) delete next[channel.id];
  else next[channel.id] = { name: channel.name, rate };
  await chrome.storage.local.set({ channelSpeeds: next });
}

function renderChannelList() {
  const entries = Object.entries(channelSpeeds).sort((a, b) => a[1].name.localeCompare(b[1].name, "ru"));
  $("#channelGroup").hidden = !entries.length;
  $("#channelList").replaceChildren(...entries.map(([id, c]) => {
    const remove = el("button", { type: "button", className: "icon-btn", title: "Убрать", ariaLabel: `Убрать скорость для ${c.name}` }, "✕");
    remove.addEventListener("click", () => setChannelSpeed({ id, name: c.name }, null));
    return el("div", { className: "row" },
      el("span", { className: "row-text" }, el("b", {}, c.name)),
      el("span", { className: "channel-rate" }, `${c.rate}×`),
      remove);
  }));
}

// ---------- Статистика ----------

function renderStats(stats) {
  const total = stats?.total ?? {};
  const today = stats?.days?.[new Date().toLocaleDateString("sv")] ?? {};
  const saved = (b) => (b.adSec ?? 0) + (b.segSec ?? 0);
  $("#savedTotal").textContent = US.formatDuration(saved(total));
  $("#savedToday").textContent = `сегодня ${US.formatDuration(saved(today))}`;
  $("#statAds").textContent = total.ads ?? 0;
  $("#statSegs").textContent = total.segs ?? 0;
  $("#statIntros").textContent = total.intros ?? 0;
}

function bindReset() {
  const btn = $("#resetStats");
  let armed = false;
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "Точно сбросить?";
      setTimeout(() => {
        armed = false;
        btn.textContent = "Сбросить статистику";
      }, 3000);
      return;
    }
    await chrome.storage.local.remove("stats");
    armed = false;
    btn.textContent = "Сбросить статистику";
  });
}

// ---------- Текущая вкладка ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshNow() {
  const tab = await activeTab();
  let status = null;
  if (tab?.id != null) {
    try {
      status = await chrome.tabs.sendMessage(tab.id, { type: "status" }, { frameId: 0 });
    } catch {}
  }
  const key = JSON.stringify([status, settings.enabled, settings.sbEnabled, channelSpeeds]);
  if (key === lastStatus) return;
  lastStatus = key;
  renderNow(status, tab);
}

function nowHead(title, pulse, extra) {
  return el("div", { className: "now-head" },
    el("div", { className: "now-title" }, el("span", { className: `pulse ${pulse}` }), title),
    extra ?? "");
}

function renderNow(status, tab) {
  const box = $("#now");
  box.replaceChildren();
  const note = (text) => el("p", { className: "now-note" }, text);
  renderNowBody(status, tab, box, note);
  // После обновления расширения уже открытые вкладки остаются без модуля пропуска, пока их не перезагрузят.
  if (settings.enabled && status?.site === "youtube" && status.skipModule === false) {
    box.append(el("p", { className: "now-warn" }, "Модуль пропуска рекламы не подключён — перезагрузите вкладку YouTube"));
  }
}

function renderNowBody(status, tab, box, note) {
  if (!settings.enabled) {
    box.append(nowHead("UltraTube на паузе", "idle"), note("Включите кнопкой справа вверху"));
    return;
  }
  if (!status) {
    box.append(nowHead("Здесь нечего пропускать", "idle"), note("Откройте видео на YouTube или Netflix"));
    return;
  }
  if (status.site === "netflix") {
    box.append(nowHead("Netflix", ""), note("Заставки и «Ранее в сериале» пропускаются автоматически"));
    return;
  }
  if (status.adShowing) {
    box.append(nowHead("Идёт реклама", "ad"), note("Пропускаем…"));
    return;
  }
  if (!status.videoId) {
    box.append(nowHead("YouTube", ""), note("Реклама пропускается, промо-блоки скрыты"));
    return;
  }

  const send = (msg) => chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 }).catch(() => {});
  const segs = settings.sbEnabled ? status.segments : [];
  const count = segs.length
    ? el("span", { className: "seg-time" }, `${segs.length} ${plural(segs.length, "вставка", "вставки", "вставок")}`)
    : null;
  box.append(nowHead("Это видео", "", count));

  if (!settings.sbEnabled) box.append(note("Пропуск спонсорских вставок выключен"));
  else if (!segs.length) box.append(note("В базе SponsorBlock нет вставок для этого видео"));
  else {
    const list = el("ul", { className: "segments" });
    for (const seg of segs) {
      const cat = US.CATEGORIES[seg.category] ?? { name: seg.category, color: "#fff" };
      const btn = el("button", { type: "button", title: "Перейти к началу вставки" },
        el("span", { className: "dot", style: `background:${cat.color}` }),
        el("span", { className: "seg-name" }, cat.name),
        seg.done
          ? el("span", { className: "seg-done" }, "пропущено")
          : el("span", { className: "seg-mode" }, US.MODES[seg.mode]?.toLowerCase() ?? ""),
        el("span", { className: "seg-time" }, `${US.formatClock(seg.start)} – ${US.formatClock(seg.end)}`));
      btn.addEventListener("click", () => send({ type: "seek", time: seg.start }));
      list.append(el("li", {}, btn));
    }
    box.append(list);

    if (status.duration > 0) {
      const line = el("div", { className: "timeline", ariaHidden: "true" });
      for (const seg of segs) {
        const left = (seg.start / status.duration) * 100;
        const width = ((Math.min(seg.end, status.duration) - seg.start) / status.duration) * 100;
        line.append(el("span", { style: `left:${left}%;width:${width}%;background:${US.CATEGORIES[seg.category]?.color ?? "#fff"}` }));
      }
      box.append(line);
    }
  }

  const chips = el("div", { className: "chips-row" });
  if (status.highlight) {
    const jump = el("button", { type: "button", className: "chip-btn chip-accent" }, `⚡ К главному · ${US.formatClock(status.highlight.start)}`);
    jump.addEventListener("click", () => send({ type: "highlight" }));
    chips.append(jump);
  }
  if (status.dislikes != null) {
    chips.append(el("span", { className: "chip-btn", title: "Оценка Return YouTube Dislike" }, `👎 ${US.formatCount(status.dislikes)}`));
  }
  if (chips.children.length) box.append(chips);

  if (status.channel) {
    const current = channelSpeeds[status.channel.id]?.rate ?? null;
    const choice = el("div", { className: "choice small", role: "group", ariaLabel: "Скорость на канале" });
    for (const value of [null, ...US.CHANNEL_SPEEDS]) {
      const btn = el("button", { type: "button" }, value == null ? "Обычная" : `${value}×`);
      btn.setAttribute("aria-pressed", current === value);
      btn.addEventListener("click", () => setChannelSpeed(status.channel, value));
      choice.append(btn);
    }
    box.append(el("div", { className: "channel" },
      el("span", { className: "channel-title" }, "Скорость на канале ", el("b", {}, status.channel.name)),
      choice));
  }
}

// ---------- Запуск ----------

(async () => {
  settings = await US.getSettings();
  buildCategories();
  buildPlayerControls();
  buildQuick();
  $("#openWelcome").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") }));
  bindTabs();
  renderSettings();
  ({ channelSpeeds = {} } = await chrome.storage.local.get("channelSpeeds"));
  renderChannelList();

  for (const input of document.querySelectorAll("[data-setting]")) {
    input.addEventListener("change", () => {
      settings[input.dataset.setting] = input.checked;
      save();
      refreshNow();
    });
  }

  const { stats } = await chrome.storage.local.get("stats");
  renderStats(stats);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.stats) renderStats(changes.stats.newValue);
    if (area === "local" && changes.channelSpeeds) {
      channelSpeeds = changes.channelSpeeds.newValue ?? {};
      renderChannelList();
      refreshNow();
    }
  });
  bindReset();

  refreshNow();
  setInterval(refreshNow, 1000);
})();
