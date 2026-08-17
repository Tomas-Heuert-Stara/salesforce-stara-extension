/**
 * Anonymous Apex runner with debug log capture.
 *
 * The Tooling API's executeAnonymous does not return a debug log, so to show one
 * we have to do what the Developer Console does: make sure a DebugLevel and a
 * TraceFlag exist for the current user, run the code, then find the ApexLog that
 * the run produced and fetch its body.
 */

const pageHost = new URLSearchParams(location.search).get("host") || "";

const el = {
  host: document.getElementById("host"),
  capture: document.getElementById("capture"),
  level: document.getElementById("level"),
  history: document.getElementById("history"),
  run: document.getElementById("run"),
  code: document.getElementById("code"),
  result: document.getElementById("result"),
  logMeta: document.getElementById("logMeta"),
  debugOnly: document.getElementById("debugOnly"),
  copyLog: document.getElementById("copyLog"),
  downloadLog: document.getElementById("downloadLog"),
  log: document.getElementById("log"),
};

let session = null;
let client = null;
let userId = null;
let currentLog = "";

const HISTORY_KEY = "apexHistory";
const HISTORY_MAX = 20;
const DEBUG_LEVEL_NAME = "StaraToolbox";
const TRACE_MINUTES = 30;

// ---------------------------------------------------------------------------
// client (same shape as the panel's; this page is standalone on purpose)
// ---------------------------------------------------------------------------

function bg(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || "Background call failed."));
      resolve(res.data);
    });
  });
}

class SalesforceClient {
  constructor(host, sessionId) {
    this.host = host;
    this.sessionId = sessionId;
    this.version = null;
  }

  async apiVersion() {
    if (this.version) return this.version;
    const versions = await this.request("/services/data/");
    this.version = versions[versions.length - 1].version;
    return this.version;
  }

  async request(path, init = {}) {
    const res = await fetch(`https://${this.host}${path}`, {
      ...init,
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${this.sessionId}`,
        Accept: "application/json",
        ...(init.headers || {}),
      },
    });

    const text = await res.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* plain text, e.g. a log body */ }

    if (!res.ok) {
      const err = new Error(salesforceError(body) || res.statusText);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async query(soql, { tooling = false } = {}) {
    const v = await this.apiVersion();
    const base = tooling ? `/services/data/v${v}/tooling/query` : `/services/data/v${v}/query`;
    return this.request(`${base}?q=${encodeURIComponent(soql)}`);
  }

  async post(path, body) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async patch(path, body) {
    return this.request(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

function salesforceError(body) {
  if (!body) return null;
  if (typeof body === "string") return body.slice(0, 400);
  if (Array.isArray(body)) return body.map(e => e.message || e.errorCode).filter(Boolean).join("; ");
  return body.message || body.error_description || null;
}

// ---------------------------------------------------------------------------
// trace flag setup
// ---------------------------------------------------------------------------

const LEVEL_PRESETS = {
  debug: {
    ApexCode: "DEBUG", ApexProfiling: "NONE", Callout: "INFO", Database: "INFO",
    System: "DEBUG", Validation: "INFO", Visualforce: "NONE", Workflow: "INFO",
  },
  finest: {
    ApexCode: "FINEST", ApexProfiling: "FINEST", Callout: "FINEST", Database: "FINEST",
    System: "FINEST", Validation: "INFO", Visualforce: "FINEST", Workflow: "FINEST",
  },
  error: {
    ApexCode: "ERROR", ApexProfiling: "NONE", Callout: "NONE", Database: "NONE",
    System: "ERROR", Validation: "NONE", Visualforce: "NONE", Workflow: "ERROR",
  },
};

async function ensureDebugLevel(preset) {
  const v = await client.apiVersion();
  const levels = LEVEL_PRESETS[preset] || LEVEL_PRESETS.debug;

  const found = await client.query(
    `SELECT Id FROM DebugLevel WHERE DeveloperName = '${DEBUG_LEVEL_NAME}' LIMIT 1`,
    { tooling: true }
  );

  if (found.records?.length) {
    const id = found.records[0].Id;
    // The user may have switched preset since last run.
    await client.patch(`/services/data/v${v}/tooling/sobjects/DebugLevel/${id}`, levels);
    return id;
  }

  const created = await client.post(`/services/data/v${v}/tooling/sobjects/DebugLevel`, {
    DeveloperName: DEBUG_LEVEL_NAME,
    MasterLabel: "Stara Toolbox",
    ...levels,
  });
  return created.id;
}

async function ensureTraceFlag(preset) {
  const v = await client.apiVersion();
  const debugLevelId = await ensureDebugLevel(preset);
  const expiration = new Date(Date.now() + TRACE_MINUTES * 60000).toISOString();

  const existing = await client.query(
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' ` +
    "AND LogType = 'DEVELOPER_LOG' ORDER BY ExpirationDate DESC LIMIT 1",
    { tooling: true }
  );

  // Salesforce rejects a second overlapping flag for the same entity, so extend
  // the existing one rather than creating another.
  if (existing.records?.length) {
    await client.patch(
      `/services/data/v${v}/tooling/sobjects/TraceFlag/${existing.records[0].Id}`,
      { DebugLevelId: debugLevelId, ExpirationDate: expiration }
    );
    return;
  }

  await client.post(`/services/data/v${v}/tooling/sobjects/TraceFlag`, {
    TracedEntityId: userId,
    LogType: "DEVELOPER_LOG",
    DebugLevelId: debugLevelId,
    StartDate: new Date(Date.now() - 60000).toISOString(),
    ExpirationDate: expiration,
  });
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newestLogId() {
  const res = await client.query(
    `SELECT Id FROM ApexLog WHERE LogUserId = '${userId}' ORDER BY StartTime DESC LIMIT 1`
  );
  return res.records?.[0]?.Id || null;
}

async function waitForNewLog(previousId, attempts = 18) {
  for (let i = 0; i < attempts; i++) {
    await sleep(600);
    const res = await client.query(
      "SELECT Id, LogLength, Operation, Status, DurationMilliseconds " +
      `FROM ApexLog WHERE LogUserId = '${userId}' ORDER BY StartTime DESC LIMIT 1`
    );
    const log = res.records?.[0];
    if (log && log.Id !== previousId) return log;
  }
  return null;
}

async function fetchLogBody(id) {
  const v = await client.apiVersion();
  try {
    return await client.request(`/services/data/v${v}/sobjects/ApexLog/${id}/Body`);
  } catch {
    return await client.request(`/services/data/v${v}/tooling/sobjects/ApexLog/${id}/Body`);
  }
}

async function run() {
  const code = el.code.value.trim();
  if (!code || !client) return;

  el.run.disabled = true;
  setResult("busy", "Running…");

  try {
    const capture = el.capture.checked;
    if (capture) {
      setResult("busy", "Preparing debug log…");
      await ensureTraceFlag(el.level.value);
    }

    const previousLogId = capture ? await newestLogId() : null;

    setResult("busy", "Executing…");
    const v = await client.apiVersion();
    const res = await client.request(
      `/services/data/v${v}/tooling/executeAnonymous/?anonymousBody=${encodeURIComponent(code)}`
    );

    renderExecutionResult(res);
    await saveHistory(code);

    if (capture) {
      el.logMeta.textContent = "Waiting for the debug log…";
      const log = await waitForNewLog(previousLogId);
      if (!log) {
        el.logMeta.textContent =
          "No new debug log appeared. The TraceFlag may not have taken effect yet — try again.";
        return;
      }
      currentLog = String(await fetchLogBody(log.Id));
      el.logMeta.textContent =
        `${log.Operation || "Anonymous Apex"} · ${formatBytes(log.LogLength)}` +
        (log.DurationMilliseconds ? ` · ${log.DurationMilliseconds} ms` : "") +
        (log.Status && log.Status !== "Success" ? ` · ${log.Status}` : "");
      renderLog();
    }
  } catch (err) {
    setResult("err", "Request failed", err.message);
  } finally {
    el.run.disabled = false;
  }
}

function renderExecutionResult(res) {
  if (res.compiled === false) {
    setResult("err", "Compile error",
      `Line ${res.line}, column ${res.column}\n${res.compileProblem || ""}`);
    return;
  }
  if (res.success === false) {
    setResult("err", "Unhandled exception",
      [res.exceptionMessage, res.exceptionStackTrace].filter(Boolean).join("\n"));
    return;
  }
  setResult("ok", "Executed successfully");
}

function setResult(tone, title, detail) {
  el.result.className = `apex-result ${tone}`;
  el.result.innerHTML = `<div><strong>${escapeHtml(title)}</strong>${
    detail ? `<pre>${escapeHtml(detail)}</pre>` : ""}</div>`;
  el.result.hidden = false;
}

// ---------------------------------------------------------------------------
// log rendering
// ---------------------------------------------------------------------------

function renderLog() {
  if (!currentLog) {
    el.log.innerHTML = `<span class="empty">Run something to see its debug log here.</span>`;
    return;
  }

  const lines = currentLog.split("\n");
  const shown = el.debugOnly.checked
    ? lines.filter(l => l.includes("|USER_DEBUG|"))
    : lines;

  if (shown.length === 0) {
    el.log.innerHTML = `<span class="empty">No USER_DEBUG lines in this log.</span>`;
    return;
  }

  el.log.innerHTML = shown.map(line => {
    const cls = line.includes("|FATAL_ERROR|") || line.includes("|EXCEPTION_THROWN|")
      ? "fatal"
      : line.includes("|USER_DEBUG|") ? "dbg" : "";
    return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
  }).join("\n");
}

const escapeHtml = v =>
  String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

async function saveHistory(code) {
  const stored = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || [];
  const next = [{ code, at: Date.now() }, ...stored.filter(h => h.code !== code)]
    .slice(0, HISTORY_MAX);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  renderHistory(next);
}

function renderHistory(list) {
  el.history.innerHTML =
    `<option value="">History…</option>` +
    list.map((h, i) => {
      const preview = h.code.replace(/\s+/g, " ").slice(0, 60);
      return `<option value="${i}">${escapeHtml(preview)}</option>`;
    }).join("");
  el.history.dataset.items = JSON.stringify(list.map(h => h.code));
}

// ---------------------------------------------------------------------------
// interactions
// ---------------------------------------------------------------------------

el.run.addEventListener("click", run);

el.code.addEventListener("keydown", ev => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    run();
    return;
  }
  // Tab should indent, not move focus out of the editor.
  if (ev.key === "Tab") {
    ev.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = el.code;
    el.code.value = `${value.slice(0, a)}  ${value.slice(b)}`;
    el.code.selectionStart = el.code.selectionEnd = a + 2;
  }
});

el.debugOnly.addEventListener("change", renderLog);

el.history.addEventListener("change", () => {
  const items = JSON.parse(el.history.dataset.items || "[]");
  const i = Number(el.history.value);
  if (el.history.value !== "" && items[i] != null) el.code.value = items[i];
  el.history.value = "";
  el.code.focus();
});

el.copyLog.addEventListener("click", async () => {
  if (!currentLog) return;
  await navigator.clipboard.writeText(currentLog).catch(() => {});
  el.copyLog.textContent = "Copied";
  setTimeout(() => { el.copyLog.textContent = "Copy log"; }, 1200);
});

el.downloadLog.addEventListener("click", () => {
  if (!currentLog) return;
  const url = URL.createObjectURL(new Blob([currentLog], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `apex-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function init() {
  renderHistory((await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || []);

  try {
    session = await bg("getSession", { host: pageHost });
  } catch (err) {
    el.host.textContent = "not connected";
    setResult("err", "No Salesforce session", err.message);
    return;
  }

  client = new SalesforceClient(session.apiHost, session.sessionId);
  el.host.textContent = session.apiHost;

  try {
    const info = await client.request("/services/oauth2/userinfo");
    userId = info.user_id;
    el.host.textContent = `${session.apiHost} · ${info.preferred_username || info.name || ""}`;
  } catch (err) {
    // Without a user id we cannot target a TraceFlag, so execution still works
    // but log capture cannot.
    el.capture.checked = false;
    el.capture.disabled = true;
    el.logMeta.textContent = `Debug log capture unavailable: ${err.message}`;
  }

  el.run.disabled = false;
  el.code.focus();
}

init();
