/** Options page: language and the panel's shortcut list. Auto-saves to storage.sync. */

import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_CATALOG,
  shortcutLabel,
  loadShortcuts,
  saveShortcuts,
  resetShortcuts,
} from "./shortcuts.js";
import {
  LOCALES,
  initI18n,
  activateLocale,
  applyStaticText,
  detectLocale,
  getLocalePreference,
  setLocalePreference,
  t,
} from "./i18n/index.js";

const rowsEl = document.getElementById("rows");
const catalogEl = document.getElementById("catalog");
const languageEl = document.getElementById("language");
const savedEl = document.getElementById("saved");

let shortcuts = [];

const esc = v =>
  String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function render() {
  rowsEl.innerHTML = shortcuts.map((s, i) => `
    <div class="row" data-i="${i}">
      <input class="label-in" type="text" value="${esc(shortcutLabel(s))}" data-field="label"
             placeholder="${esc(t("options.labelPlaceholder"))}">
      ${s.kind
        ? `<span class="builtin">${esc(t("options.builtin", { kind: s.kind }))}</span>`
        : `<input class="path-in" type="text" value="${esc(s.path || "")}" data-field="path"
                  placeholder="/lightning/setup/…" spellcheck="false">`}
      <span class="row-actions">
        <button class="btn small icon" data-move="-1" title="${esc(t("options.moveUp"))}"
                ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="btn small icon" data-move="1" title="${esc(t("options.moveDown"))}"
                ${i === shortcuts.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn small icon danger" data-remove
                title="${esc(t("options.remove"))}">✕</button>
      </span>
    </div>`).join("");
}

function renderCatalog() {
  catalogEl.innerHTML = SHORTCUT_CATALOG.map(
    (s, i) => `<option value="${i}">${esc(shortcutLabel(s))}</option>`
  ).join("");
}

async function renderLanguage() {
  const preference = await getLocalePreference();
  const detected = LOCALES.find(l => l.code === detectLocale())?.label || detectLocale();
  languageEl.innerHTML =
    `<option value="auto">${esc(t("options.languageAuto", { name: detected }))}</option>` +
    LOCALES.map(l => `<option value="${esc(l.code)}">${esc(l.label)}</option>`).join("");
  languageEl.value = preference;
}

let savedTimer = null;
function flashSaved() {
  savedEl.classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove("on"), 1400);
}

async function persist() {
  await saveShortcuts(shortcuts);
  flashSaved();
}

// Text edits save on a short debounce so typing does not hammer storage.sync,
// which has a write-rate quota.
let editTimer = null;
rowsEl.addEventListener("input", ev => {
  const input = ev.target.closest("[data-field]");
  if (!input) return;
  const i = Number(input.closest(".row").dataset.i);

  if (input.dataset.field === "label") {
    // Typing over a catalog label makes it the user's own string, which means it
    // must stop following the interface language.
    shortcuts[i] = { ...shortcuts[i], label: input.value };
    delete shortcuts[i].key;
  } else {
    shortcuts[i][input.dataset.field] = input.value;
  }

  clearTimeout(editTimer);
  editTimer = setTimeout(persist, 400);
});

rowsEl.addEventListener("click", async ev => {
  const row = ev.target.closest(".row");
  if (!row) return;
  const i = Number(row.dataset.i);

  const move = ev.target.closest("[data-move]");
  if (move) {
    const j = i + Number(move.dataset.move);
    if (j < 0 || j >= shortcuts.length) return;
    [shortcuts[i], shortcuts[j]] = [shortcuts[j], shortcuts[i]];
    render();
    await persist();
    return;
  }

  if (ev.target.closest("[data-remove]")) {
    shortcuts.splice(i, 1);
    render();
    await persist();
  }
});

document.getElementById("addCatalog").addEventListener("click", async () => {
  shortcuts.push({ ...SHORTCUT_CATALOG[Number(catalogEl.value)] });
  render();
  await persist();
});

document.getElementById("addCustom").addEventListener("click", async () => {
  shortcuts.push({ label: t("options.newShortcut"), path: "/lightning/setup/" });
  render();
  await persist();
  rowsEl.querySelector(".row:last-child .label-in")?.select();
});

document.getElementById("reset").addEventListener("click", async () => {
  await resetShortcuts();
  shortcuts = structuredClone(DEFAULT_SHORTCUTS);
  render();
  flashSaved();
});

languageEl.addEventListener("change", async () => {
  const preference = languageEl.value;
  await setLocalePreference(preference);
  // Re-translate this page in place; the panel reloads itself on the same event.
  await activateLocale(preference === "auto" ? detectLocale() : preference);
  await redraw();
  flashSaved();
});

async function redraw() {
  applyStaticText();
  document.getElementById("version").textContent =
    t("options.version", { version: chrome.runtime.getManifest().version });
  renderCatalog();
  await renderLanguage();
  render();
}

async function init() {
  await initI18n();
  shortcuts = structuredClone(await loadShortcuts());
  await redraw();
}

init();
