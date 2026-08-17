/**
 * Tiny i18n runtime.
 *
 * Chrome's own i18n (_locales + chrome.i18n.getMessage) resolves against the
 * browser's UI language and cannot be overridden at runtime, so a user-chosen
 * language needs its own lookup. Dictionaries are plain ES modules loaded on
 * demand; English is always loaded as the fallback.
 *
 * Escaping: t() does not escape. Dictionary strings are ours and trusted, but
 * interpolated params often are not - escape them at the call site when the
 * result goes into innerHTML, exactly as the code does without i18n.
 */

export const FALLBACK_LOCALE = "en";
export const STORAGE_KEY = "locale";

/** Add a language: drop in ./<code>.js, then add both entries here. */
export const LOCALES = [
  { code: "en", label: "English" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" },
];

const LOADERS = {
  "en": () => import("./en.js"),
  "pt-BR": () => import("./pt-BR.js"),
  "es": () => import("./es.js"),
  "ru": () => import("./ru.js"),
};

let current = FALLBACK_LOCALE;
let dict = {};
let fallbackDict = {};
let plural = new Intl.PluralRules(FALLBACK_LOCALE);
let nf = new Intl.NumberFormat(FALLBACK_LOCALE);
let timeFmt = new Intl.DateTimeFormat(FALLBACK_LOCALE, { timeStyle: "medium" });
let shortTimeFmt = new Intl.DateTimeFormat(FALLBACK_LOCALE, { hour: "2-digit", minute: "2-digit" });
let dateFmt = new Intl.DateTimeFormat(FALLBACK_LOCALE, { dateStyle: "short" });
let dayMonthFmt = new Intl.DateTimeFormat(FALLBACK_LOCALE, { day: "2-digit", month: "2-digit" });
let rtf = new Intl.RelativeTimeFormat(FALLBACK_LOCALE, { numeric: "auto", style: "narrow" });

export const getLocale = () => current;

/** Resolve a stored preference ("auto" or a code) to something we can load. */
export function resolveLocale(preference) {
  if (preference && preference !== "auto" && LOADERS[preference]) return preference;
  return detectLocale();
}

export function detectLocale() {
  const wanted = navigator.languages?.length
    ? navigator.languages
    : [navigator.language || FALLBACK_LOCALE];

  for (const tag of wanted) {
    if (LOADERS[tag]) return tag;
    const base = tag.split("-")[0];
    const hit = Object.keys(LOADERS).find(code => code.split("-")[0] === base);
    if (hit) return hit;
  }
  return FALLBACK_LOCALE;
}

export async function activateLocale(code) {
  const target = LOADERS[code] ? code : FALLBACK_LOCALE;

  fallbackDict = (await LOADERS[FALLBACK_LOCALE]()).default;
  dict = target === FALLBACK_LOCALE ? fallbackDict : (await LOADERS[target]()).default;
  current = target;

  plural = new Intl.PluralRules(target);
  nf = new Intl.NumberFormat(target);
  timeFmt = new Intl.DateTimeFormat(target, { timeStyle: "medium" });
  shortTimeFmt = new Intl.DateTimeFormat(target, { hour: "2-digit", minute: "2-digit" });
  dateFmt = new Intl.DateTimeFormat(target, { dateStyle: "short" });
  dayMonthFmt = new Intl.DateTimeFormat(target, { day: "2-digit", month: "2-digit" });
  rtf = new Intl.RelativeTimeFormat(target, { numeric: "auto", style: "narrow" });

  document.documentElement.lang = target;
  return target;
}

/** Read the stored preference and activate it. Returns the active code. */
export async function initI18n() {
  const stored = (await chrome.storage.sync.get(STORAGE_KEY))[STORAGE_KEY];
  return activateLocale(resolveLocale(stored || "auto"));
}

export async function getLocalePreference() {
  return (await chrome.storage.sync.get(STORAGE_KEY))[STORAGE_KEY] || "auto";
}

export async function setLocalePreference(preference) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: preference });
}

/**
 * Look up a key. Plural entries are objects keyed by CLDR category, which is why
 * selection goes through Intl.PluralRules - Russian needs one/few/many, and
 * hard-coding an English one/other split would quietly mistranslate it.
 */
export function t(key, params) {
  let entry = dict[key];
  if (entry === undefined) entry = fallbackDict[key];
  if (entry === undefined) return key; // visible on screen, so it gets noticed

  if (entry && typeof entry === "object") {
    const category = plural.select(Number(params?.count) || 0);
    entry = entry[category] ?? entry.other ?? fallbackDict[key]?.other ?? key;
  }

  return interpolate(entry, params);
}

function interpolate(text, params) {
  if (!params) return text;
  return String(text).replace(/\{(\w+)\}/g, (whole, name) => {
    if (!(name in params)) return whole;
    const value = params[name];
    return name === "count" && typeof value === "number" ? nf.format(value) : String(value);
  });
}

// ---------------------------------------------------------------------------
// locale-aware formatting
// ---------------------------------------------------------------------------

export const fmt = {
  number: n => nf.format(Number(n) || 0),
  fixed: (n, digits) =>
    new Intl.NumberFormat(current, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Number(n) || 0),
  time: d => timeFmt.format(d),
  shortTime: d => shortTimeFmt.format(d),
  date: d => dateFmt.format(d),
  dayMonth: d => dayMonthFmt.format(d),

  /** Intl handles the wording, so "5m ago" needs no dictionary entries at all. */
  relative(iso) {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return "—";
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
    if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
    if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
    if (abs < 604_800_000) return rtf.format(Math.round(diff / 86_400_000), "day");
    return dateFmt.format(new Date(ts));
  },

  /** Short absolute stamp: time today, date + time otherwise. */
  absoluteShort(iso) {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return "—";
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? shortTimeFmt.format(d) : `${dayMonthFmt.format(d)} ${shortTimeFmt.format(d)}`;
  },

  duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}${t("unit.s")}`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}${t("unit.m")} ${s % 60}${t("unit.s")}`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}${t("unit.h")} ${m % 60}${t("unit.m")}`;
    return `${Math.floor(h / 24)}${t("unit.d")} ${h % 24}${t("unit.h")}`;
  },

  megabytes(mb) {
    const n = Number(mb) || 0;
    return n >= 1024
      ? `${this.fixed(n / 1024, 1)} ${t("unit.gb")}`
      : `${nf.format(Math.round(n))} ${t("unit.mb")}`;
  },

  bytes(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 ** 3) return `${this.fixed(n / 1024 ** 3, 2)} ${t("unit.gb")}`;
    if (n >= 1024 ** 2) return `${this.fixed(n / 1024 ** 2, 1)} ${t("unit.mb")}`;
    return `${this.fixed(n / 1024, 0)} ${t("unit.kb")}`;
  },
};

// ---------------------------------------------------------------------------
// static markup
// ---------------------------------------------------------------------------

/** Fills every [data-i18n*] element. Safe to call again after a locale change. */
export function applyStaticText(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(node => {
    node.textContent = t(node.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-title]").forEach(node => {
    node.title = t(node.dataset.i18nTitle);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach(node => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
}

/** Fires when the language preference changes in any window. */
export function onLocaleChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORAGE_KEY]) callback(changes[STORAGE_KEY].newValue);
  });
}
