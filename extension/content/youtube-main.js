// Работает в мире страницы: только отсюда доступны методы плеера YouTube.
// Кнопка «Пропустить» сама по себе лишь вызывает player.onAdUxClicked("skip-button", layoutId),
// а синтетические клики YouTube игнорирует (проверяет isTrusted) — поэтому вызываем метод напрямую.
(() => {
  if (window.__ultraSkipMain) return;
  window.__ultraSkipMain = true;
  document.documentElement.dataset.ultraskipMain = "1";

  const MAX_IDS = 300;
  const seen = new Set();

  function collect(root, into) {
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 60) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "layoutId" && typeof value === "string") into.add(value);
        else walk(value, depth + 1);
      }
    };
    walk(root, 0);
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
})();
