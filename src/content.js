/**
 * Injects the launcher tab and the slide-out panel host.
 *
 * Everything lives in a shadow root so Salesforce's (very opinionated) stylesheets
 * cannot reach it, and the panel itself is an extension page in an iframe so it can
 * call the Salesforce API without fighting the page's CSP.
 */
(() => {
  if (window.top !== window.self) return; // never inside Lightning's VF iframes
  if (document.getElementById("stara-sfx-root")) return;

  const PANEL_URL = chrome.runtime.getURL("src/panel.html");
  const MIN_WIDTH = 300;
  const MAX_WIDTH = 720;
  const DEFAULT_WIDTH = 380;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed;
      inset: 0 0 auto auto;
      height: 100vh;
      width: 0;
      z-index: 2147483600;
      pointer-events: none;
      font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .tab {
      position: absolute;
      top: 34vh;
      right: 0;
      width: 22px;
      height: 74px;
      padding: 0;
      border: 0;
      border-radius: 6px 0 0 6px;
      background: #0b5cab;
      color: #fff;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: -2px 0 8px rgba(0, 0, 0, .28);
      transition: right .22s ease, background .15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .tab:hover { background: #0d6ecb; }
    .tab svg { width: 13px; height: 13px; transition: transform .22s ease; }
    .wrap.open .tab svg { transform: rotate(180deg); }
    .panel {
      position: absolute;
      top: 0;
      right: 0;
      height: 100%;
      width: var(--sfx-w, ${DEFAULT_WIDTH}px);
      background: #fff;
      transform: translateX(100%);
      transition: transform .22s ease;
      pointer-events: auto;
      box-shadow: -4px 0 18px rgba(0, 0, 0, .22);
    }
    .wrap.open .panel { transform: none; }
    .wrap.open .tab { right: var(--sfx-w, ${DEFAULT_WIDTH}px); }
    .wrap.dragging .panel, .wrap.dragging .tab { transition: none; }
    .wrap.dragging iframe { pointer-events: none; }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    .grip {
      position: absolute;
      top: 0;
      left: -3px;
      width: 7px;
      height: 100%;
      cursor: col-resize;
    }
    @media (prefers-color-scheme: dark) {
      .panel, iframe { background: #16181d; }
    }
  `;

  const root = document.createElement("div");
  root.id = "stara-sfx-root";
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${STYLE}</style>
    <div class="wrap" part="wrap">
      <button class="tab" title="Stara SF Toolbox (Alt+Shift+S)" aria-label="Toggle Stara SF Toolbox">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>
      </button>
      <div class="panel">
        <div class="grip"></div>
        <iframe title="Stara SF Toolbox" allow="clipboard-write"></iframe>
      </div>
    </div>
  `;
  (document.body || document.documentElement).appendChild(root);

  const wrap = shadow.querySelector(".wrap");
  const tab = shadow.querySelector(".tab");
  const grip = shadow.querySelector(".grip");
  const iframe = shadow.querySelector("iframe");

  let width = DEFAULT_WIDTH;
  let loaded = false;

  chrome.storage.local.get(["panelOpen", "panelWidth"]).then(cfg => {
    setWidth(cfg.panelWidth || DEFAULT_WIDTH);
    if (cfg.panelOpen) setOpen(true, { persist: false });
  });

  function setWidth(px) {
    width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
    wrap.style.setProperty("--sfx-w", `${width}px`);
  }

  function setOpen(open, { persist = true } = {}) {
    if (open && !loaded) {
      iframe.src = `${PANEL_URL}?host=${encodeURIComponent(location.hostname)}`;
      loaded = true;
    }
    wrap.classList.toggle("open", open);
    if (persist) chrome.storage.local.set({ panelOpen: open });
    postToPanel({ type: "visibility", visible: open });
  }

  const isOpen = () => wrap.classList.contains("open");

  function postToPanel(msg) {
    if (!loaded) return;
    iframe.contentWindow?.postMessage({ source: "stara-sfx-host", ...msg }, "*");
  }

  tab.addEventListener("click", () => setOpen(!isOpen()));

  // ---- resize -------------------------------------------------------------
  grip.addEventListener("mousedown", ev => {
    ev.preventDefault();
    wrap.classList.add("dragging");
    const startX = ev.clientX;
    const startWidth = width;

    const onMove = e => setWidth(startWidth + (startX - e.clientX));
    const onUp = () => {
      wrap.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      chrome.storage.local.set({ panelWidth: width });
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // ---- panel -> page ------------------------------------------------------
  window.addEventListener("message", ev => {
    if (ev.source !== iframe.contentWindow) return;
    const msg = ev.data;
    if (!msg || msg.source !== "stara-sfx-panel") return;

    switch (msg.type) {
      case "ready":
        postToPanel({ type: "visibility", visible: isOpen() });
        break;
      case "close":
        setOpen(false);
        break;
      case "navigate":
        if (msg.newTab) window.open(msg.url, "_blank", "noopener");
        else location.assign(msg.url);
        break;
      case "openWindow":
        window.open(msg.url, msg.name || "_blank", msg.features || "noopener");
        break;
    }
  });

  // ---- toolbar button / keyboard shortcut ---------------------------------
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === "togglePanel") setOpen(!isOpen());
  });

  document.addEventListener("visibilitychange", () => {
    postToPanel({ type: "visibility", visible: isOpen() && !document.hidden });
  });
})();
