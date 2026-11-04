const $ = (sel) => document.querySelector(sel);
let settings;
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
  document.body.classList.toggle("off", !settings.enabled);
  $("#tagline").textContent = settings.enabled ? "Реклама, спонсоры, заставки" : "На паузе";
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
  const key = JSON.stringify([status, settings.enabled, settings.sbEnabled]);
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
    box.append(nowHead("UltraSkip на паузе", "idle"), note("Включите кнопкой справа вверху"));
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
    box.append(nowHead("Идёт реклама", "ad"), note("Ускоряем и жмём «Пропустить»…"));
    return;
  }
  if (!status.videoId) {
    box.append(nowHead("YouTube", ""), note("Реклама ускоряется, промо-блоки скрыты"));
    return;
  }
  if (!settings.sbEnabled) {
    box.append(nowHead("Это видео", ""), note("Пропуск спонсорских вставок выключен"));
    return;
  }

  const segs = status.segments;
  if (!segs.length) {
    box.append(nowHead("Это видео", ""), note("В базе SponsorBlock нет вставок для этого видео"));
    return;
  }

  const count = el("span", { className: "seg-time" }, `${segs.length} ${plural(segs.length, "вставка", "вставки", "вставок")}`);
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
    btn.addEventListener("click", () => {
      chrome.tabs.sendMessage(tab.id, { type: "seek", time: seg.start }, { frameId: 0 }).catch(() => {});
    });
    list.append(el("li", {}, btn));
  }
  box.append(nowHead("Это видео", "", count), list);

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

// ---------- Запуск ----------

(async () => {
  settings = await US.getSettings();
  buildCategories();
  renderSettings();

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
  });
  bindReset();

  refreshNow();
  setInterval(refreshNow, 1000);
})();
