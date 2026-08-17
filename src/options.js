/** Options page: edit the panel's shortcut list. Auto-saves to chrome.storage.sync. */

import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_CATALOG,
  loadShortcuts,
  saveShortcuts,
  resetShortcuts,
} from "./shortcuts.js";

const rowsEl = document.getElementById("rows");
const catalogEl = document.getElementById("catalog");
const savedEl = document.getElementById("saved");

let shortcuts = [];

const esc = v =>
  String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function render() {
  rowsEl.innerHTML = shortcuts.map((s, i) => `
    <div class="row" data-i="${i}">
      <input class="label-in" type="text" value="${esc(s.label)}" data-field="label"
             placeholder="Label">
      ${s.kind
        ? `<span class="builtin">built-in action: ${esc(s.kind)}</span>`
        : `<input class="path-in" type="text" value="${esc(s.path || "")}" data-field="path"
                  placeholder="/lightning/setup/…" spellcheck="false">`}
      <span class="row-actions">
        <button class="btn small icon" data-move="-1" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="btn small icon" data-move="1" title="Move down"
                ${i === shortcuts.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn small icon danger" data-remove title="Remove">✕</button>
      </span>
    </div>`).join("");
}

function renderCatalog() {
  catalogEl.innerHTML = SHORTCUT_CATALOG.map(
    (s, i) => `<option value="${i}">${esc(s.label)}</option>`
  ).join("");
}

let savedTimer = null;
async function persist() {
  await saveShortcuts(shortcuts);
  savedEl.classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove("on"), 1400);
}

// Text edits save on a short debounce so typing does not hammer storage.sync,
// which has a write-rate quota.
let editTimer = null;
rowsEl.addEventListener("input", ev => {
  const input = ev.target.closest("[data-field]");
  if (!input) return;
  const i = Number(input.closest(".row").dataset.i);
  shortcuts[i][input.dataset.field] = input.value;
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
  shortcuts.push({ label: "New shortcut", path: "/lightning/setup/" });
  render();
  await persist();
  rowsEl.querySelector(".row:last-child .label-in")?.select();
});

document.getElementById("reset").addEventListener("click", async () => {
  await resetShortcuts();
  shortcuts = structuredClone(DEFAULT_SHORTCUTS);
  render();
  savedEl.classList.add("on");
  setTimeout(() => savedEl.classList.remove("on"), 1400);
});

async function init() {
  document.getElementById("version").textContent = chrome.runtime.getManifest().version;
  renderCatalog();
  shortcuts = structuredClone(await loadShortcuts());
  render();
}

init();
