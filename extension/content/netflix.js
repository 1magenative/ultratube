(() => {
  if (window.__ultraSkip) return;
  window.__ultraSkip = true;

  const BUTTONS = [
    { setting: "nfSkipIntro", selector: '[data-uia="player-skip-intro"]', stat: "intros" },
    { setting: "nfSkipRecap", selector: '[data-uia="player-skip-recap"], [data-uia="player-skip-preplay"]', stat: "intros" },
    { setting: "nfNextEpisode", selector: '[data-uia="next-episode-seamless-button"], [data-uia="next-episode-seamless-button-draining"]' },
  ];

  let settings = { ...US.DEFAULTS };
  US.getSettings().then((s) => (settings = s));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) settings = US.merge(changes.settings.newValue);
  });

  const clicked = new WeakSet();
  function scan() {
    if (!settings.enabled || !chrome.runtime?.id) return;
    for (const { setting, selector, stat } of BUTTONS) {
      if (!settings[setting]) continue;
      for (const btn of document.querySelectorAll(selector)) {
        if (clicked.has(btn)) continue;
        clicked.add(btn);
        btn.click();
        if (stat) chrome.runtime.sendMessage({ type: "stat", delta: { [stat]: 1 } }).catch(() => {});
      }
    }
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "status") reply({ site: "netflix" });
  });
})();
