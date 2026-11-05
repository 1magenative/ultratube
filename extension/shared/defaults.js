globalThis.US = {
  DEFAULTS: {
    enabled: true,
    ytSpeedAds: true,
    ytSkipAds: true,
    ytHidePromos: true,
    ytHideShorts: false,
    ytQuality: "auto",
    ytSpeed: null,
    ytFastSpeed: true,
    ytShortsAsVideo: false,
    ytHighlight: true,
    ytNonstop: true,
    ytNoAutoplay: false,
    ytOriginalAudio: true,
    ytDislikes: true,
    hideRecs: false,
    hideComments: false,
    hideEndCards: false,
    hideHomeFeed: false,
    fakePremium: false,
    ambient: false,
    ambientMusic: false,
    ambientStrength: 70,
    ambientSize: 50,
    musicStrength: 80,
    musicSize: 60,
    musicPulse: true,
    audioBoostOn: false,
    audioBoost: 150,
    audioNight: false,
    audioNormalize: false,
    audioEq: false,
    audioEqPreset: "voice",
    audioEqBands: [0, 0, 0, 0, 0],
    ambientHeader: true,
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

  QUALITIES: {
    auto: "Не менять",
    max: "Максимальное",
    hd2160: "4K",
    hd1440: "1440p",
    hd1080: "1080p",
    hd720: "720p",
    large: "480p",
  },

  SPEEDS: [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4],
  CHANNEL_SPEEDS: [1, 1.5, 2, 2.5, 3, 4],
  MAX_RATE: 4,

  // Эквалайзер: 5 полос (дБ) и готовые настройки.
  EQ_BANDS: [
    { freq: 60, type: "lowshelf", label: "60" },
    { freq: 250, type: "peaking", label: "250" },
    { freq: 1000, type: "peaking", label: "1к" },
    { freq: 4000, type: "peaking", label: "4к" },
    { freq: 12000, type: "highshelf", label: "12к" },
  ],
  EQ_PRESETS: {
    flat: { name: "Ровно", bands: [0, 0, 0, 0, 0] },
    voice: { name: "Голос", bands: [-4, -1, 3, 4, 1] },
    bass: { name: "Басы", bands: [7, 4, 0, 0, 1] },
    clarity: { name: "Чётко", bands: [-1, 0, 1, 4, 6] },
    custom: { name: "Свой", bands: null },
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

  formatCount(n) {
    return new Intl.NumberFormat("ru", { notation: "compact", maximumFractionDigits: 1 }).format(n);
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
