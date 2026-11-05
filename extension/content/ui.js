// Общие детали для кнопок и панелей UltraTube в плеерах YouTube и YouTube Music (подсветка, звук).
(() => {
  if (globalThis.USUI) return;
  const MUSIC = location.hostname === "music.youtube.com";
  const SVG = "http://www.w3.org/2000/svg";

  function el(tag, className, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.append(...children);
    return node;
  }

  function icon(d) {
    const node = document.createElementNS(SVG, "svg");
    node.setAttribute("viewBox", "0 0 24 24");
    node.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    node.append(path);
    return node;
  }

  // Поле для ввода целого числа с клавиатуры: Enter или уход из поля применяют, Esc отменяет, стрелки — ±1.
  // Значение вне границ прижимается к ним; знак «+» у положительных — для децибел эквалайзера.
  function numberField({ min, max, signed = false, label, onCommit }) {
    const input = el("input", "us-ap-num");
    Object.assign(input, { type: "text", inputMode: "numeric", autocomplete: "off", spellcheck: false });
    input.setAttribute("aria-label", label);
    let value = min;
    const show = (v) => (signed && v > 0 ? `+${v}` : String(v));
    const set = (v) => {
      value = v;
      if (document.activeElement !== input) input.value = show(v);
    };
    const commit = (v) => {
      const next = Math.min(max, Math.max(min, Math.round(v)));
      input.value = show(next);
      if (next !== value) {
        value = next;
        onCommit(next);
      }
    };
    input.addEventListener("focus", () => input.select());
    input.addEventListener("input", () => {
      const clean = input.value.replace(signed ? /[^\d+-]/g : /\D/g, "");
      if (clean !== input.value) input.value = clean;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        input.blur();
      } else if (e.key === "Escape") {
        input.value = show(value);
        input.blur();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        commit((Number.parseInt(input.value, 10) || value) + (e.key === "ArrowUp" ? 1 : -1));
        input.select();
      }
    });
    input.addEventListener("blur", () => {
      const typed = Number.parseInt(input.value, 10);
      if (Number.isFinite(typed)) commit(typed);
      else input.value = show(value);
    });
    return { input, set };
  }

  // Ползунок с подписью и полем для точного значения справа. onInput получает целое число.
  function slider({ label, min = 0, max = 100, step = 1, unit = "%", onInput }) {
    const input = el("input", "us-ap-range");
    Object.assign(input, { type: "range", min, max, step });
    input.setAttribute("aria-label", label);
    const paint = (value) => input.style.setProperty("--fill", `${((value - min) / (max - min)) * 100}%`);
    const field = numberField({
      min,
      max,
      label: `${label}, ${unit}`,
      onCommit(value) {
        input.value = value;
        paint(value);
        onInput(value);
      },
    });
    const value = el("span", "us-ap-value", field.input, el("span", "", unit));
    const row = el("div", "us-ap-row", el("div", "us-ap-label", el("span", "", label), value), input);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      paint(v);
      field.set(v);
      onInput(v);
    });
    return {
      row,
      input,
      set(v) {
        if (document.activeElement !== input) input.value = v;
        paint(v);
        field.set(v);
      },
    };
  }

  function toggle({ label, hint, onChange }) {
    const input = el("input", "us-ap-switch");
    input.type = "checkbox";
    input.addEventListener("change", () => onChange(input.checked));
    const text = el("span", "", el("b", "", label));
    if (hint) text.append(el("small", "", hint));
    return { row: el("label", "us-ap-toggle", text, input), input };
  }

  // Кнопка в панели управления плеера и всплывающая над ней панель. Открытая панель закрывает другие.
  function playerPanel({ name, title, iconPath, children }) {
    const button = el("button", `${MUSIC ? "us-player-btn us-music" : "ytp-button us-player-btn"} us-${name}-btn`, icon(iconPath));
    button.type = "button";
    button.title = `${title} — UltraTube`;
    button.setAttribute("aria-label", `Настроить: ${title.toLowerCase()}`);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");

    const panel = el("div", `us-panel us-${name}-panel${MUSIC ? " us-music" : ""}`,
      el("div", "us-ap-head", el("b", "", title), el("span", "", "UltraTube")),
      ...children);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", title);
    // Клики и клавиши внутри панели не должны ставить видео на паузу или перематывать его.
    for (const type of ["click", "dblclick", "mousedown", "pointerdown", "keydown", "wheel"]) {
      panel.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "keydown" && e.key === "Escape") close();
      });
    }

    const outside = (e) => {
      if (!panel.contains(e.target) && !button.contains(e.target)) close();
    };

    function open() {
      document.dispatchEvent(new CustomEvent("ultratube:panel", { detail: name }));
      api.onOpen?.();
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

    function close() {
      panel.remove();
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside, true);
    }

    document.addEventListener("ultratube:panel", (e) => {
      if (e.detail !== name) close();
    });
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel.isConnected) close();
      else open();
    });

    // Вызывается периодически: кнопка на месте, пока функция включена.
    function ensure(wanted) {
      if (!wanted) {
        close();
        button.remove();
        return;
      }
      // В узком окне YouTube Music прячет часть кнопок панели — тогда встаём просто в правую часть панели.
      const visible = (selector) => [...document.querySelectorAll(selector)].find((node) => node.offsetWidth);
      const host = MUSIC
        ? visible("ytmusic-player-bar .right-controls-buttons") ?? visible("ytmusic-player-bar #right-controls")
        : (location.pathname === "/watch" ? document.querySelector("#movie_player .ytp-right-controls") : null);
      if (!host) {
        close();
        button.remove();
        return;
      }
      // В новом интерфейсе YouTube кнопка настроек лежит во вложенной группе — сравниваем с её родителем,
      // иначе кнопки подсветки и звука каждые полсекунды переставляли бы друг друга (и мигали).
      const anchor = MUSIC ? null : host.querySelector(".ytp-settings-button");
      const parent = anchor?.parentElement ?? host;
      if (button.parentElement === parent) return;
      if (anchor) anchor.before(button);
      else host.prepend(button);
    }

    const api = { button, panel, open, close, ensure, onOpen: null };
    return api;
  }

  // Сохранить часть настроек через небольшую паузу (ползунки шлют событие на каждый шаг).
  function saver() {
    let timer = 0;
    let patch = {};
    return (part) => {
      Object.assign(patch, part);
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const current = await US.getSettings();
        const next = { ...current, ...patch };
        patch = {};
        await chrome.storage.sync.set({ settings: next });
      }, 300);
    };
  }

  globalThis.USUI = { MUSIC, el, icon, numberField, slider, toggle, playerPanel, saver };
})();
