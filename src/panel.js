/**
 * Panel app. Runs on the extension origin inside an iframe on the Salesforce page,
 * so it can call the org's REST/Tooling API directly using the session id the
 * service worker digs out of the cookie jar.
 *
 * Deployments and Apex jobs poll on independent timers: a running deploy is worth
 * watching second-by-second, job counters are not.
 */

const POLL_DEPLOY_ACTIVE_MS = 4000;
const POLL_DEPLOY_IDLE_MS = 30000;
const POLL_JOBS_MS = 30000;

const pageHost = new URLSearchParams(location.search).get("host") || location.hostname;

const el = {
  orgHost: document.getElementById("orgHost"),
  envBadge: document.getElementById("envBadge"),
  banner: document.getElementById("banner"),
  updateBanner: document.getElementById("updateBanner"),
  refreshAll: document.getElementById("refreshAll"),
  refreshDeploy: document.getElementById("refreshDeploy"),
  refreshJobs: document.getElementById("refreshJobs"),
  close: document.getElementById("closeBtn"),
  deploy: document.getElementById("deploy"),
  kpis: document.getElementById("kpis"),
  kpiErr: document.getElementById("kpiErr"),
  runningJobs: document.getElementById("runningJobs"),
  updated: document.getElementById("updated"),
  pollNote: document.getElementById("pollNote"),
};

let session = null;
let client = null;
let visible = true;

const deployDetails = new Map(); // deploy id -> details payload (or an Error)

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

function toHost(msg) {
  parent.postMessage({ source: "stara-sfx-panel", ...msg }, "*");
}

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
    const cached = sessionStorage.getItem(`apiVersion:${this.host}`);
    if (cached) return (this.version = cached);

    const versions = await this.request("/services/data/");
    this.version = versions[versions.length - 1].version;
    sessionStorage.setItem(`apiVersion:${this.host}`, this.version);
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
    try { body = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }

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

  /** One API call for many reads - keeps the org's daily API budget intact. */
  async batch(paths) {
    const v = await this.apiVersion();
    const body = await this.request(`/services/data/v${v}/composite/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchRequests: paths.map(p => ({ method: "GET", url: `v${v}/${p}` })),
      }),
    });
    return body.results.map(r =>
      r.statusCode >= 200 && r.statusCode < 300
        ? { ok: true, value: r.result }
        : { ok: false, error: withStatus(new Error(salesforceError(r.result) || `HTTP ${r.statusCode}`), r.statusCode) }
    );
  }
}

function withStatus(err, status) {
  err.status = status;
  return err;
}

function salesforceError(body) {
  if (!body) return null;
  if (typeof body === "string") return body.slice(0, 400);
  if (Array.isArray(body)) return body.map(e => e.message || e.errorCode).filter(Boolean).join("; ");
  return body.message || body.error_description || null;
}

const soqlPath = q => `query?q=${encodeURIComponent(q)}`;

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

// BatchApexWorker rows are the individual chunks of a running batch job; counting
// them would report a single batch as hundreds of jobs, so they are excluded
// everywhere - same as the Apex Jobs page in Setup.
const NOT_WORKER = "JobType != 'BatchApexWorker'";
const RUNNING_WHERE = `Status IN ('Processing', 'Preparing') AND ${NOT_WORKER}`;

// CronJobDetail.JobType '7' is Scheduled Apex.
const Q_SCHEDULED =
  "SELECT COUNT() FROM CronTrigger WHERE CronJobDetail.JobType = '7' " +
  "AND State NOT IN ('DELETED', 'COMPLETE')";
const Q_RUNNING = `SELECT COUNT() FROM AsyncApexJob WHERE ${RUNNING_WHERE}`;
// Batch jobs parked in the Apex flex queue sit in Holding.
const Q_FLEX = `SELECT COUNT() FROM AsyncApexJob WHERE Status = 'Holding'`;

// Relationship fields can be blocked by field-level security on User, so fall
// back to a flat projection if the richer one is rejected.
const RUNNING_DETAIL_QUERIES = [
  "SELECT Id, Status, JobType, MethodName, ApexClass.Name, CreatedBy.Name, CreatedDate, " +
    "TotalJobItems, JobItemsProcessed, NumberOfErrors, ExtendedStatus " +
    `FROM AsyncApexJob WHERE ${RUNNING_WHERE} ORDER BY CreatedDate DESC LIMIT 25`,
  "SELECT Id, Status, JobType, MethodName, ApexClassId, CreatedById, CreatedDate, " +
    "TotalJobItems, JobItemsProcessed, NumberOfErrors, ExtendedStatus " +
    `FROM AsyncApexJob WHERE ${RUNNING_WHERE} ORDER BY CreatedDate DESC LIMIT 25`,
];
let runningQueryIndex = 0;

const DEPLOY_FIELDS_FULL =
  "Id, Status, StartDate, CompletedDate, CreatedDate, CreatedBy.Name, CheckOnly, " +
  "RunTestsEnabled, TestLevel, NumberComponentsDeployed, NumberComponentsTotal, " +
  "NumberComponentErrors, NumberTestsCompleted, NumberTestsTotal, NumberTestErrors, " +
  "StateDetail, ErrorMessage, ErrorStatusCode";
const DEPLOY_FIELDS_MIN =
  "Id, Status, StartDate, CompletedDate, CreatedDate, CheckOnly, " +
  "NumberComponentsDeployed, NumberComponentsTotal, NumberComponentErrors, " +
  "NumberTestsCompleted, NumberTestsTotal, NumberTestErrors";

// Field availability on DeployRequest varies by org/API version, so probe once
// and remember whichever shape the org accepts.
const DEPLOY_QUERIES = [
  `SELECT ${DEPLOY_FIELDS_FULL} FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 6`,
  `SELECT ${DEPLOY_FIELDS_MIN} FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 6`,
  `SELECT ${DEPLOY_FIELDS_MIN} FROM DeployRequest LIMIT 6`,
];
let deployQueryIndex = 0;

async function fetchDeployments() {
  let lastError = null;
  for (let i = deployQueryIndex; i < DEPLOY_QUERIES.length; i++) {
    try {
      const res = await client.query(DEPLOY_QUERIES[i], { tooling: true });
      deployQueryIndex = i;
      return (res.records || []).sort(
        (a, b) => Date.parse(b.CreatedDate || b.StartDate || 0) - Date.parse(a.CreatedDate || a.StartDate || 0)
      );
    } catch (err) {
      if (err.status === 401 || err.status === 403) throw err;
      lastError = err;
    }
  }
  throw lastError || new Error("Could not read DeployRequest.");
}

async function fetchDeployDetails(id) {
  if (deployDetails.has(id)) return deployDetails.get(id);
  const v = await client.apiVersion();
  try {
    const body = await client.request(
      `/services/data/v${v}/metadata/deployRequest/${id}?includeDetails=true`
    );
    const result = body?.deployResult || body;
    deployDetails.set(id, result);
    return result;
  } catch (err) {
    deployDetails.set(id, err);
    return err;
  }
}

// ---------------------------------------------------------------------------
// refresh cycles
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = new Set(["Pending", "InProgress", "Canceling"]);
const isActive = d => ACTIVE_STATUSES.has(d?.Status);

let lastDeploys = [];
let deployTimer = null;
let jobsTimer = null;
let deployBusy = false;
let jobsBusy = false;
let deployStamp = null;
let jobsStamp = null;

async function refreshDeploys() {
  if (deployBusy || !client) return;
  deployBusy = true;
  el.refreshDeploy.classList.add("spin");

  try {
    const deploys = await fetchDeployments();
    hideBanner();
    await renderDeployments({ status: "fulfilled", value: deploys });
    deployStamp = new Date();
  } catch (err) {
    if (isAuthError(err)) {
      showBanner("Salesforce session expired. Reload the page and try again.");
    } else {
      await renderDeployments({ status: "rejected", reason: err });
      deployStamp = new Date();
    }
  } finally {
    deployBusy = false;
    el.refreshDeploy.classList.remove("spin");
    stampFooter();
    scheduleDeploys();
  }
}

async function refreshJobs({ retry = true } = {}) {
  if (jobsBusy || !client) return;
  jobsBusy = true;
  el.refreshJobs.classList.add("spin");

  try {
    const results = await client.batch([
      soqlPath(Q_SCHEDULED),
      soqlPath(Q_RUNNING),
      soqlPath(Q_FLEX),
      soqlPath(RUNNING_DETAIL_QUERIES[runningQueryIndex]),
    ]);

    if (results.some(r => !r.ok && isAuthError(r.error))) {
      showBanner("Salesforce session expired. Reload the page and try again.");
      return;
    }

    // The detail projection was rejected - drop to the flat one and try again once.
    const detail = results[3];
    if (!detail.ok && retry && runningQueryIndex < RUNNING_DETAIL_QUERIES.length - 1) {
      runningQueryIndex++;
      jobsBusy = false;
      el.refreshJobs.classList.remove("spin");
      return refreshJobs({ retry: false });
    }

    hideBanner();
    renderKpis(results.slice(0, 3));
    renderRunningJobs(detail, results[1]);
    jobsStamp = new Date();
  } catch (err) {
    if (isAuthError(err)) {
      showBanner("Salesforce session expired. Reload the page and try again.");
    } else {
      renderKpis(null, err);
      jobsStamp = new Date();
    }
  } finally {
    jobsBusy = false;
    el.refreshJobs.classList.remove("spin");
    stampFooter();
    scheduleJobs();
  }
}

const isAuthError = err => err?.status === 401 || err?.status === 403;

function scheduleDeploys() {
  clearTimeout(deployTimer);
  if (!visible) return;
  const active = lastDeploys.some(isActive);
  deployTimer = setTimeout(refreshDeploys, active ? POLL_DEPLOY_ACTIVE_MS : POLL_DEPLOY_IDLE_MS);
  updatePollNote();
}

function scheduleJobs() {
  clearTimeout(jobsTimer);
  if (!visible) return;
  jobsTimer = setTimeout(refreshJobs, POLL_JOBS_MS);
  updatePollNote();
}

function updatePollNote() {
  if (!visible) {
    el.pollNote.textContent = "paused";
    return;
  }
  const active = lastDeploys.some(isActive);
  el.pollNote.textContent = `deploys ${active ? "4s" : "30s"} · jobs 30s`;
}

function stampFooter() {
  const t = d => (d ? d.toLocaleTimeString() : "—");
  el.updated.textContent = `deploys ${t(deployStamp)} · jobs ${t(jobsStamp)}`;
}

// ---------------------------------------------------------------------------
// rendering: KPIs
// ---------------------------------------------------------------------------

function renderKpis(results, fatal) {
  const tiles = el.kpis.querySelectorAll(".kpi");

  if (fatal) {
    tiles.forEach(t => { t.querySelector(".kpi-n").textContent = "!"; t.classList.remove("hot"); });
    el.kpiErr.textContent = fatal.message;
    el.kpiErr.hidden = false;
    return;
  }

  const messages = [];
  results.forEach((r, i) => {
    const tile = tiles[i];
    const n = tile.querySelector(".kpi-n");
    if (r.ok) {
      const count = r.value.totalSize ?? 0;
      n.textContent = count;
      // Running and flex-queue tiles read as "attention" when non-zero.
      tile.classList.toggle("hot", count > 0 && i > 0);
    } else {
      n.textContent = "!";
      tile.classList.remove("hot");
      messages.push(`${tile.dataset.kpi}: ${r.error.message}`);
    }
  });

  el.kpiErr.textContent = messages.join(" · ");
  el.kpiErr.hidden = messages.length === 0;
}

// ---------------------------------------------------------------------------
// rendering: running jobs
// ---------------------------------------------------------------------------

/**
 * Throughput samples per job id, collected across refreshes.
 *
 * AsyncApexJob has no "started processing" timestamp - CreatedDate is when the job
 * was queued, which for anything that waited in the flex queue makes a naive
 * items/elapsed rate far too pessimistic. Once we have watched a job across two
 * polls we can measure the real rate instead.
 */
const jobSamples = new Map();

function sampleJob(job, now) {
  const n = Number(job.JobItemsProcessed) || 0;
  const existing = jobSamples.get(job.Id);
  if (!existing) {
    const fresh = { firstT: now, firstN: n, lastT: now, lastN: n };
    jobSamples.set(job.Id, fresh);
    return fresh;
  }
  existing.lastT = now;
  existing.lastN = n;
  return existing;
}

const MIN_SAMPLE_SPAN_MS = 10000;

function estimateEta(job, sample, now) {
  const total = Number(job.TotalJobItems) || 0;
  const done = Number(job.JobItemsProcessed) || 0;
  if (!total || done >= total) return null;

  const span = sample.lastT - sample.firstT;
  const delta = sample.lastN - sample.firstN;

  let rate = null;      // items per ms
  let measured = false;
  if (span >= MIN_SAMPLE_SPAN_MS && delta > 0) {
    rate = delta / span;
    measured = true;
  } else {
    const elapsed = now - Date.parse(job.CreatedDate);
    if (elapsed > 0 && done > 0) rate = done / elapsed;
  }
  if (!rate || !Number.isFinite(rate)) return null;

  const remainingMs = (total - done) / rate;
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;

  return { remainingMs, finishAt: new Date(now + remainingMs), measured };
}

function renderRunningJobs(detail, countResult) {
  if (!detail.ok) {
    el.runningJobs.innerHTML =
      `<p class="jobs-more">Job detail unavailable: ${esc(detail.error.message)}</p>`;
    return;
  }

  const jobs = detail.value.records || [];
  jobSamples.forEach((_, id) => {
    if (!jobs.some(j => j.Id === id)) jobSamples.delete(id);
  });

  if (jobs.length === 0) {
    el.runningJobs.innerHTML = "";
    return;
  }

  const now = Date.now();
  const total = countResult?.ok ? countResult.value.totalSize ?? jobs.length : jobs.length;
  const hidden = total - jobs.length;

  el.runningJobs.innerHTML =
    `<div class="jobs">${jobs.map(j => jobRow(j, now)).join("")}</div>` +
    (hidden > 0 ? `<p class="jobs-more">+ ${hidden} more not shown</p>` : "");
}

function jobRow(job, now) {
  const sample = sampleJob(job, now);
  const eta = estimateEta(job, sample, now);

  const name = job.ApexClass?.Name || "(class unavailable)";
  const method = job.MethodName ? `<span class="method">.${esc(job.MethodName)}</span>` : "";
  const who = job.CreatedBy?.Name;

  const total = Number(job.TotalJobItems) || 0;
  const done = Number(job.JobItemsProcessed) || 0;
  const errors = Number(job.NumberOfErrors) || 0;

  const parts = [
    `<div class="job">`,
    `<div class="job-top">`,
    `<span class="job-name">${esc(name)}${method}</span>`,
    `<span class="job-type">${esc(prettyJobType(job.JobType))}</span>`,
    `</div>`,
    `<div class="job-meta">`,
    who ? `<span>by ${esc(who)}</span>` : "",
    `<span>started ${esc(relative(job.CreatedDate))}</span>`,
    job.Status === "Preparing" ? `<span>preparing…</span>` : "",
    errors > 0 ? `<span class="job-errs">${errors} error${errors > 1 ? "s" : ""}</span>` : "",
    `</div>`,
  ];

  if (total > 0) {
    parts.push(progressBar("Batches", done, total, errors));
  }

  if (eta) {
    const basis = eta.measured
      ? "measured from observed throughput"
      : "estimated from average since the job was queued";
    parts.push(
      `<p class="job-eta" title="${esc(basis)}">~${esc(duration(eta.remainingMs))} left ` +
      `<span class="soft">· done around ${esc(eta.finishAt.toLocaleTimeString())}` +
      `${eta.measured ? "" : " (rough)"}</span></p>`
    );
  }

  if (job.ExtendedStatus) {
    parts.push(`<p class="job-ext">${esc(job.ExtendedStatus)}</p>`);
  }

  parts.push(`</div>`);
  return parts.join("");
}

function prettyJobType(type) {
  switch (type) {
    case "BatchApex": return "Batch";
    case "BatchApexWorker": return "Batch chunk";
    case "ScheduledApex": return "Scheduled";
    case "TestRequest":
    case "TestWorker": return "Test";
    case "SharingRecalculation": return "Sharing";
    case "ApexToken": return "Token";
    default: return type || "Apex";
  }
}

// ---------------------------------------------------------------------------
// rendering: deployments
// ---------------------------------------------------------------------------

async function renderDeployments(settled) {
  if (settled.status === "rejected") {
    lastDeploys = [];
    el.deploy.innerHTML = `<p class="empty">Could not read deployments: ${esc(settled.reason.message)}</p>`;
    return;
  }

  lastDeploys = settled.value;
  if (lastDeploys.length === 0) {
    el.deploy.innerHTML = `<p class="empty">No deployments recorded in this org.</p>`;
    return;
  }

  const running = lastDeploys.filter(isActive);
  const featured = running[0] || lastDeploys[0];

  // Only pull the heavy detail payload when there is something to show in it.
  let details = null;
  if ((featured.NumberComponentErrors > 0 || featured.NumberTestErrors > 0) && !isActive(featured)) {
    details = await fetchDeployDetails(featured.Id);
  }

  const rest = lastDeploys.filter(d => d.Id !== featured.Id).slice(0, 4);

  el.deploy.innerHTML =
    deployCard(featured, details) +
    (rest.length
      ? `<details class="recent"><summary>${rest.length} earlier deployment${rest.length > 1 ? "s" : ""}</summary>
           ${rest.map(recentRow).join("")}
         </details>`
      : "");
}

function deployCard(d, details) {
  const s = statusLook(d.Status);
  const kind = d.CheckOnly ? "Validation" : "Deployment";
  const who = d.CreatedBy?.Name ? ` · ${esc(d.CreatedBy.Name)}` : "";
  const active = isActive(d);

  const parts = [
    `<div class="card ${active ? "active" : ""}">`,
    `<div class="card-top">`,
    `<span class="pill ${s.tone}">${esc(s.label)}</span>`,
    `<span style="font-weight:600">${kind}</span>`,
    `<span class="tagline">${esc(timeSummary(d))}</span>`,
    `</div>`,
    `<div class="card-meta">`,
    `<span>${esc(shortId(d.Id))}${who}</span>`,
    d.TestLevel ? `<span>tests: <b>${esc(d.TestLevel)}</b></span>` : "",
    `</div>`,
  ];

  if (d.NumberComponentsTotal > 0) {
    parts.push(progressBar(
      "Components",
      d.NumberComponentsDeployed,
      d.NumberComponentsTotal,
      d.NumberComponentErrors
    ));
  }
  if (d.NumberTestsTotal > 0) {
    parts.push(progressBar(
      "Tests",
      d.NumberTestsCompleted,
      d.NumberTestsTotal,
      d.NumberTestErrors
    ));
  }

  if (active && d.StateDetail) {
    parts.push(`<p class="state-detail">${esc(d.StateDetail)}</p>`);
  }
  if (d.ErrorMessage) {
    parts.push(`<p class="state-detail" style="color:var(--err);font-style:normal">${esc(d.ErrorMessage)}</p>`);
  }

  const failures = collectFailures(details);
  if (failures.length) {
    parts.push(
      `<details class="errs" open><summary>${failures.length} failure${failures.length > 1 ? "s" : ""}</summary>`,
      failures.map(f => `<div class="err-item"><b>${esc(f.title)}</b><span>${esc(f.body)}</span></div>`).join(""),
      `</details>`
    );
  } else if (details instanceof Error) {
    parts.push(`<p class="state-detail">Failure details unavailable: ${esc(details.message)}</p>`);
  }

  parts.push(`</div>`);
  return parts.join("");
}

function progressBar(label, done, total, errors) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const tone = errors > 0 ? "err" : pct === 100 ? "ok" : "";
  const errText = errors > 0 ? ` · ${errors} error${errors > 1 ? "s" : ""}` : "";
  return `<div class="bar-row">
    <div class="bar-lab"><span>${label}</span><span>${done ?? 0}/${total}${errText}</span></div>
    <div class="bar"><i class="${tone}" style="width:${pct}%"></i></div>
  </div>`;
}

/** Salesforce collapses single-element arrays into objects; normalise both. */
const toArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

function collectFailures(details) {
  if (!details || details instanceof Error) return [];
  const d = details.details || {};
  const out = [];

  for (const f of toArray(d.componentFailures).slice(0, 20)) {
    const where = f.lineNumber ? ` (line ${f.lineNumber}${f.columnNumber ? `, col ${f.columnNumber}` : ""})` : "";
    out.push({
      title: `${f.componentType || "Component"}: ${f.fullName || f.fileName || "?"}${where}`,
      body: f.problem || "",
    });
  }

  const tests = d.runTestResult || {};
  for (const f of toArray(tests.failures).slice(0, 20)) {
    out.push({
      title: `Test: ${f.name || "?"}.${f.methodName || ""}`,
      body: [f.message, f.stackTrace].filter(Boolean).join("\n"),
    });
  }

  return out;
}

function recentRow(d) {
  const s = statusLook(d.Status);
  return `<div class="recent-row">
    <span class="pill ${s.tone}">${esc(s.label)}</span>
    <span>${d.CheckOnly ? "Validation" : "Deploy"}</span>
    <span class="when">${esc(relative(d.CompletedDate || d.StartDate || d.CreatedDate))}</span>
  </div>`;
}

function statusLook(status) {
  switch (status) {
    case "Succeeded": return { label: "Succeeded", tone: "ok" };
    case "SucceededPartial": return { label: "Partial", tone: "warn" };
    case "Failed": return { label: "Failed", tone: "err" };
    case "Canceled": return { label: "Canceled", tone: "idle" };
    case "Canceling": return { label: "Canceling", tone: "warn" };
    case "InProgress": return { label: "In progress", tone: "run" };
    case "Pending": return { label: "Pending", tone: "run" };
    default: return { label: status || "Unknown", tone: "idle" };
  }
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function timeSummary(d) {
  if (isActive(d)) {
    const start = Date.parse(d.StartDate || d.CreatedDate);
    return Number.isNaN(start) ? "running" : `running ${duration(Date.now() - start)}`;
  }
  const end = d.CompletedDate || d.StartDate || d.CreatedDate;
  const start = Date.parse(d.StartDate || d.CreatedDate);
  const finish = Date.parse(end);
  const took = !Number.isNaN(start) && !Number.isNaN(finish) && finish > start
    ? ` · ${duration(finish - start)}`
    : "";
  return `${relative(end)}${took}`;
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function relative(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(t).toLocaleDateString();
}

const shortId = id => (id || "").slice(0, 15);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function showBanner(html) {
  el.banner.innerHTML = html;
  el.banner.hidden = false;
}
function hideBanner() {
  el.banner.hidden = true;
}

// ---------------------------------------------------------------------------
// update nag
// ---------------------------------------------------------------------------

/**
 * A developer-mode install never updates itself, so the best we can do is notice
 * that the repo has moved on and tell the user to pull. The reload button re-reads
 * the folder from disk so they do not have to visit chrome://extensions.
 */
async function checkForUpdate({ force = false } = {}) {
  let info;
  try {
    info = await bg("checkUpdate", { force });
  } catch (err) {
    // Offline, rate limited, repo renamed - never worth interrupting the user over.
    console.warn("[Stara SF Toolbox] update check failed:", err.message);
    return;
  }

  if (!info.configured || !info.outdated) {
    el.updateBanner.hidden = true;
    return;
  }

  const { updateDismissed } = await chrome.storage.local.get("updateDismissed");
  if (!force && updateDismissed === info.latest) return;

  el.updateBanner.innerHTML = `
    <div class="banner-title">Update available: v${esc(info.latest)}</div>
    <div class="banner-body">
      You are on v${esc(info.current)}. Run <code>git pull</code> in the extension
      folder, then reload it.
    </div>
    <div class="banner-actions">
      <button class="banner-btn" data-action="reload-ext">Reload extension</button>
      <button class="banner-btn" data-href="${esc(info.commitsUrl)}">What changed</button>
      <button class="banner-btn" data-action="dismiss-update"
              data-version="${esc(info.latest)}">Dismiss</button>
    </div>`;
  el.updateBanner.hidden = false;
}

// ---------------------------------------------------------------------------
// interactions
// ---------------------------------------------------------------------------

document.addEventListener("click", ev => {
  const link = ev.target.closest("[data-href]");
  if (link) {
    toHost({ type: "navigate", url: link.dataset.href, newTab: true });
    return;
  }

  const action = ev.target.closest("[data-action]")?.dataset.action;
  if (action === "reload-ext") {
    // The panel dies with the extension context, so say what happens next first.
    el.updateBanner.innerHTML =
      `<div class="banner-title">Reloading…</div>
       <div class="banner-body">Refresh this Salesforce tab to bring the panel back.</div>`;
    bg("reloadExtension").catch(() => {});
    return;
  }
  if (action === "dismiss-update") {
    const version = ev.target.closest("[data-action]").dataset.version;
    chrome.storage.local.set({ updateDismissed: version });
    el.updateBanner.hidden = true;
    return;
  }

  const setupTarget = ev.target.closest("[data-setup]");
  if (setupTarget) {
    ev.preventDefault();
    if (!session) return;
    toHost({
      type: "navigate",
      url: `https://${session.lightningHost}${setupTarget.dataset.setup}`,
      newTab: ev.ctrlKey || ev.metaKey || ev.shiftKey,
    });
    return;
  }

  if (ev.target.closest("[data-devconsole]")) {
    if (!session) return;
    toHost({
      type: "openWindow",
      url: `https://${session.apiHost}/_ui/common/apex/debug/ApexCSIPage`,
      name: "DeveloperConsole",
      features: "width=1280,height=800,resizable=yes,scrollbars=yes,toolbar=no,location=no",
    });
  }
});

el.refreshDeploy.addEventListener("click", () => refreshDeploys());
el.refreshJobs.addEventListener("click", () => refreshJobs());
el.refreshAll.addEventListener("click", () => {
  el.refreshAll.classList.add("spin");
  Promise.all([refreshDeploys(), refreshJobs(), checkForUpdate({ force: true })])
    .finally(() => el.refreshAll.classList.remove("spin"));
});
el.close.addEventListener("click", () => toHost({ type: "close" }));

window.addEventListener("message", ev => {
  const msg = ev.data;
  if (msg?.source !== "stara-sfx-host") return;
  if (msg.type !== "visibility") return;

  const wasHidden = !visible;
  visible = msg.visible;

  if (!visible) {
    clearTimeout(deployTimer);
    clearTimeout(jobsTimer);
    updatePollNote();
  } else if (wasHidden) {
    refreshDeploys();
    refreshJobs();
  }
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function init() {
  toHost({ type: "ready" });

  document.querySelector(".hd-title").title = `v${chrome.runtime.getManifest().version}`;
  checkForUpdate(); // fire and forget - never blocks the org data

  try {
    session = await bg("getSession", { host: pageHost });
  } catch (err) {
    el.orgHost.textContent = "not connected";
    el.deploy.innerHTML = "";
    showBanner(esc(err.message));
    return;
  }

  client = new SalesforceClient(session.apiHost, session.sessionId);
  el.orgHost.textContent = session.apiHost;
  el.orgHost.title = `${session.apiHost} · org ${session.orgId}`;

  const sandbox = /\.sandbox\.|--/.test(session.apiHost);
  el.envBadge.textContent = sandbox ? "Sandbox" : "Prod";
  el.envBadge.className = `env ${sandbox ? "sandbox" : "prod"}`;
  el.envBadge.hidden = false;

  await Promise.all([refreshDeploys(), refreshJobs()]);
}

init();
