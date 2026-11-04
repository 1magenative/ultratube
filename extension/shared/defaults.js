globalThis.US = {
  DEFAULTS: {
    enabled: true,
    ytSpeedAds: true,
    ytSkipAds: true,
    ytHidePromos: true,
    ytHideShorts: false,
    sbEnabled: true,
    sbModes: {
      sponsor: "auto",
      selfpromo: "auto",
      interaction: "auto",
      intro: "off",
      outro: "off",
      preview: "off",
      filler: "off",
      music_offtopic: "off",
    },
    sbToast: true,
    sbBar: true,
    nfSkipIntro: true,
    nfSkipRecap: true,
    nfNextEpisode: false,
  },

  CATEGORIES: {
    sponsor: { name: "Спонсор", color: "#00d400" },
    selfpromo: { name: "Самореклама", color: "#ffff00" },
    interaction: { name: "Призыв подписаться", color: "#cc00ff" },
    intro: { name: "Заставка", color: "#00ffff" },
    outro: { name: "Концовка", color: "#0202ed" },
    preview: { name: "Превью / повтор", color: "#008fd6" },
    filler: { name: "Отступление", color: "#7300ff" },
    music_offtopic: { name: "Не музыка", color: "#ff9900" },
  },

  MODES: {
    auto: "Авто",
    manual: "Кнопка",
    show: "Метка",
    off: "Выкл",
  },

  merge(stored) {
    return { ...US.DEFAULTS, ...stored, sbModes: { ...US.DEFAULTS.sbModes, ...stored?.sbModes } };
  },

  async getSettings() {
    const { settings } = await chrome.storage.sync.get("settings");
    return US.merge(settings);
  },

  activeCategories(settings) {
    return Object.keys(US.CATEGORIES).filter((c) => (settings.sbModes[c] ?? "off") !== "off");
  },

  formatClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  },

  formatDuration(sec) {
    sec = Math.round(sec);
    if (sec < 60) return `${sec} с`;
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
  },
};
