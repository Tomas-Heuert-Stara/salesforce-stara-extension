/**
 * Panel app. Runs on the extension origin inside an iframe on the Salesforce page,
 * so it can call the org's REST/Tooling API directly using the session id the
 * service worker digs out of the cookie jar.
 *
 * Four independent refresh cycles:
 *   deploys - 4s while one is running, 30s otherwise
 *   jobs    - 30s, everything in one composite/batch call
 *   limits  - 60s, its own fetch so the section's refresh button really refreshes it
 *   org     - identity and coverage; boot and on demand only
 */

import { loadShortcuts, shortcutLabel, SHORTCUTS_KEY } from "./shortcuts.js";
import { initI18n, applyStaticText, onLocaleChanged, t, fmt } from "./i18n/index.js";

const POLL_DEPLOY_ACTIVE_MS = 4000;
const POLL_DEPLOY_IDLE_MS = 30000;
const POLL_JOBS_MS = 30000;
const POLL_LIMITS_MS = 60000;

const pageHost = new URLSearchParams(location.search).get("host") || location.hostname;

const el = {
  orgName: document.getElementById("orgName"),
  orgHost: document.getElementById("orgHost"),
  envBadge: document.getElementById("envBadge"),
  banner: document.getElementById("banner"),
  updateBanner: document.getElementById("updateBanner"),
  optionsBtn: document.getElementById("optionsBtn"),
  refreshAll: document.getElementById("refreshAll"),
  refreshDeploy: document.getElementById("refreshDeploy"),
  refreshJobs: document.getElementById("refreshJobs"),
  refreshOrg: document.getElementById("refreshOrg"),
  editShortcuts: document.getElementById("editShortcuts"),
  close: document.getElementById("closeBtn"),
  deploy: document.getElementById("deploy"),
  kpis: document.getElementById("kpis"),
  kpiErr: document.getElementById("kpiErr"),
  runningJobs: document.getElementById("runningJobs"),
  failedJobs: document.getElementById("failedJobs"),
  scheduledJobs: document.getElementById("scheduledJobs"),
  limits: document.getElementById("limits"),
  coverage: document.getElementById("coverage"),
  logs: document.getElementById("logs"),
  jumpInput: document.getElementById("jumpInput"),
  jumpHint: document.getElementById("jumpHint"),
  shortcuts: document.getElementById("shortcuts"),
  updated: document.getElementById("updated"),
  pollNote: document.getElementById("pollNote"),
};

let session = null;
let client = null;
let visible = true;

const deployDetails = new Map(); // deploy id -> details payload (or an Error)

/** Translate, but keep the raw Salesforce value when we have no wording for it. */
const tOr = (key, fallback) => {
  const value = t(key);
  return value === key ? fallback : value;
};

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

function toHost(msg) {
  parent.postMessage({ source: "orgscope-panel", ...msg }, "*");
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

/**
 * After a git pull the panel is served fresh from disk but the MV3 service worker
 * keeps running the code it was registered with, so newer message types come back
 * as "Unknown message type". That reads as a broken button unless we name it.
 */
const isStaleWorker = err =>
  /unknown message type|extension context invalidated|receiving end does not exist/i
    .test(err?.message || "");

function reportBgError(err) {
  if (!isStaleWorker(err)) {
    showBanner(esc(err.message));
    return;
  }
  showBanner(`
    <div class="banner-title">${esc(t("stale.title"))}</div>
    <div class="banner-body">${esc(t("stale.body"))}</div>
    <div class="banner-actions">
      <button class="banner-btn" data-action="reload-ext">${esc(t("stale.reload"))}</button>
    </div>`);
}

/**
 * Every link in the panel opens a new tab, and it has to go through the service
 * worker: window.open from the host page is not a user gesture there, so popup
 * blockers silently swallow it.
 */
function openTab(url) {
  bg("openTab", { url }).catch(reportBgError);
}

/**
 * <details> elements are rebuilt on every poll, which would otherwise slam them
 * shut mid-read. Remember each one by key and restore it on the next render.
 * The toggle event does not bubble, hence the capture-phase listener.
 */
const detailsOpen = new Map();

function detailsAttr(key, defaultOpen = false) {
  const open = detailsOpen.has(key) ? detailsOpen.get(key) : defaultOpen;
  return `data-key="${key}"${open ? " open" : ""}`;
}

document.addEventListener("toggle", ev => {
  const d = ev.target;
  if (d.tagName === "DETAILS" && d.dataset.key) detailsOpen.set(d.dataset.key, d.open);
}, true);

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
const isAuthError = err => err?.status === 401 || err?.status === 403;

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

// BatchApexWorker rows are the individual chunks of a running batch job; counting
// them would report a single batch as hundreds of jobs, so they are excluded
// everywhere - same as the Apex Jobs page in Setup.
const NOT_WORKER = "JobType != 'BatchApexWorker'";
const RUNNING_WHERE = `Status IN ('Processing', 'Preparing') AND ${NOT_WORKER}`;

// CronJobDetail.JobType '7' is Scheduled Apex.
const SCHEDULED_WHERE =
  "CronJobDetail.JobType = '7' AND State NOT IN ('DELETED', 'COMPLETE')";

const Q_SCHEDULED = `SELECT COUNT() FROM CronTrigger WHERE ${SCHEDULED_WHERE}`;
const Q_RUNNING = `SELECT COUNT() FROM AsyncApexJob WHERE ${RUNNING_WHERE}`;
// Batch jobs parked in the Apex flex queue sit in Holding.
const Q_FLEX = "SELECT COUNT() FROM AsyncApexJob WHERE Status = 'Holding'";
const Q_SCHEDULED_DETAIL =
  "SELECT Id, CronJobDetail.Name, CronExpression, State, NextFireTime, " +
  "PreviousFireTime, TimesTriggered " +
  `FROM CronTrigger WHERE ${SCHEDULED_WHERE} ORDER BY NextFireTime ASC NULLS LAST LIMIT 60`;
const Q_LOG_COUNT = "SELECT COUNT() FROM ApexLog";
const Q_LOG_SIZE = "SELECT SUM(LogLength) total FROM ApexLog";
const Q_ORG =
  "SELECT Id, Name, InstanceName, OrganizationType, IsSandbox FROM Organization LIMIT 1";
const Q_COVERAGE = "SELECT PercentCovered FROM ApexOrgWideCoverage";

// Relationship fields can be blocked by field-level security on User, so keep a
// flat projection to fall back to. Both AsyncApexJob queries share the choice.
const JOB_FIELD_SETS = ["ApexClass.Name, CreatedBy.Name", "ApexClassId, CreatedById"];
let jobFieldsIndex = 0;

const runningDetailQuery = () =>
  `SELECT Id, Status, JobType, MethodName, ${JOB_FIELD_SETS[jobFieldsIndex]}, CreatedDate, ` +
  "TotalJobItems, JobItemsProcessed, NumberOfErrors, ExtendedStatus " +
  `FROM AsyncApexJob WHERE ${RUNNING_WHERE} ORDER BY CreatedDate DESC LIMIT 25`;

const failedJobsQuery = () =>
  `SELECT Id, JobType, MethodName, ${JOB_FIELD_SETS[jobFieldsIndex]}, CompletedDate, ` +
  "ExtendedStatus, NumberOfErrors, TotalJobItems, JobItemsProcessed " +
  `FROM AsyncApexJob WHERE Status = 'Failed' AND ${NOT_WORKER} ` +
  "AND CompletedDate = LAST_N_DAYS:1 ORDER BY CompletedDate DESC LIMIT 15";

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
      if (isAuthError(err)) throw err;
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
let limitsTimer = null;
let deployBusy = false;
let jobsBusy = false;
let limitsBusy = false;
let orgBusy = false;
let deployStamp = null;
let jobsStamp = null;
let limitsStamp = null;

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
      showBanner(esc(t("session.expired")));
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
    const r = await client.batch([
      soqlPath(Q_SCHEDULED),
      soqlPath(Q_RUNNING),
      soqlPath(Q_FLEX),
      soqlPath(runningDetailQuery()),
      soqlPath(Q_SCHEDULED_DETAIL),
      soqlPath(failedJobsQuery()),
      soqlPath(Q_LOG_COUNT),
      soqlPath(Q_LOG_SIZE),
    ]);

    if (r.some(x => !x.ok && isAuthError(x.error))) {
      showBanner(esc(t("session.expired")));
      return;
    }

    // The relationship projection was rejected - drop to the flat one, once.
    if (!r[3].ok && retry && jobFieldsIndex < JOB_FIELD_SETS.length - 1) {
      jobFieldsIndex++;
      jobsBusy = false;
      el.refreshJobs.classList.remove("spin");
      return refreshJobs({ retry: false });
    }

    hideBanner();
    renderKpis(r.slice(0, 3));
    renderRunningJobs(r[3], r[1]);
    renderScheduledJobs(r[4], r[0]);
    renderFailedJobs(r[5]);
    renderLogs(r[6], r[7]);
    jobsStamp = new Date();
  } catch (err) {
    if (isAuthError(err)) {
      showBanner(esc(t("session.expired")));
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

/** Limits get their own call so the section's refresh button actually refreshes them. */
async function refreshLimits() {
  if (limitsBusy || !client) return;
  limitsBusy = true;
  el.refreshOrg.classList.add("spin");

  try {
    const v = await client.apiVersion();
    renderLimits({ ok: true, value: await client.request(`/services/data/v${v}/limits`) });
    limitsStamp = new Date();
  } catch (err) {
    renderLimits({ ok: false, error: err });
  } finally {
    limitsBusy = false;
    el.refreshOrg.classList.remove("spin");
    stampFooter();
    scheduleLimits();
  }
}

/** Org identity and code coverage barely move, so there is no timer for them. */
async function refreshOrgMeta() {
  if (orgBusy || !client) return;
  orgBusy = true;

  const [org, coverage] = await Promise.allSettled([
    client.query(Q_ORG),
    client.query(Q_COVERAGE, { tooling: true }),
  ]);

  if (org.status === "fulfilled") renderOrgIdentity(org.value.records?.[0]);
  renderCoverage(coverage);
  orgBusy = false;
}

function scheduleDeploys() {
  clearTimeout(deployTimer);
  if (!visible) return updatePollNote();
  const active = lastDeploys.some(isActive);
  deployTimer = setTimeout(refreshDeploys, active ? POLL_DEPLOY_ACTIVE_MS : POLL_DEPLOY_IDLE_MS);
  updatePollNote();
}

function scheduleJobs() {
  clearTimeout(jobsTimer);
  if (!visible) return updatePollNote();
  jobsTimer = setTimeout(refreshJobs, POLL_JOBS_MS);
  updatePollNote();
}

function scheduleLimits() {
  clearTimeout(limitsTimer);
  if (!visible) return updatePollNote();
  limitsTimer = setTimeout(refreshLimits, POLL_LIMITS_MS);
  updatePollNote();
}

function updatePollNote() {
  if (!visible) {
    el.pollNote.textContent = t("footer.paused");
    el.pollNote.title = t("footer.pausedTooltip");
    return;
  }
  const active = lastDeploys.some(isActive);
  el.pollNote.textContent = active ? t("footer.live") : t("footer.auto");
  el.pollNote.title = t("footer.cadence", {
    deploys: active ? "4s" : "30s", jobs: "30s", limits: "60s",
  });
}

function stampFooter() {
  const stamps = [deployStamp, jobsStamp, limitsStamp].filter(Boolean);
  if (stamps.length === 0) return;
  const latest = new Date(Math.max(...stamps.map(d => d.getTime())));
  const at = d => (d ? fmt.time(d) : "—");
  el.updated.textContent = t("footer.updated", { time: fmt.time(latest) });
  el.updated.title = t("footer.cadence", {
    deploys: at(deployStamp), jobs: at(jobsStamp), limits: at(limitsStamp),
  });
}

// ---------------------------------------------------------------------------
// rendering: org identity, limits, coverage
// ---------------------------------------------------------------------------

function renderOrgIdentity(org) {
  if (!org) return;
  el.orgName.textContent = org.Name || "Orgscope";
  el.orgName.title = `${org.Name || ""} · ${org.OrganizationType || ""} · ${org.InstanceName || ""}` +
    ` · v${chrome.runtime.getManifest().version}`;
  el.envBadge.textContent = org.IsSandbox ? t("env.sandbox") : t("env.prod");
  el.envBadge.className = `env ${org.IsSandbox ? "sandbox" : "prod"}`;
  el.envBadge.hidden = false;
}

// Only the limits worth watching day to day; /limits returns dozens.
const WATCHED_LIMITS = [
  ["DailyApiRequests", "n"],
  ["DailyAsyncApexExecutions", "n"],
  ["DataStorageMB", "mb"],
  ["FileStorageMB", "mb"],
  ["SingleEmail", "n"],
  ["MassEmail", "n"],
  ["HourlyTimeBasedWorkflow", "n"],
];

function renderLimits(result) {
  if (!result.ok) {
    el.limits.innerHTML =
      `<p class="empty">${esc(t("limits.unavailable", { error: result.error.message }))}</p>`;
    return;
  }

  const data = result.value || {};
  const rows = WATCHED_LIMITS.map(([key, unit]) => {
    const lim = data[key];
    if (!lim || typeof lim.Max !== "number") return "";

    const label = tOr(`limits.${key}`, key);
    const max = lim.Max;
    // Remaining goes negative once a limit is blown through; used must follow it
    // past 100% rather than being clamped, or the row hides the actual problem.
    const used = max - (lim.Remaining ?? 0);
    const pct = max > 0 ? Math.round((used / max) * 100) : 0;
    const width = Math.min(100, Math.max(0, pct));
    const tone = pct > 100 ? "over" : pct >= 90 ? "bad" : pct >= 75 ? "warn" : "";
    const format = unit === "mb" ? v => fmt.megabytes(v) : v => fmt.number(v);

    const tip = t("limits.tooltip", { label, used: format(used), max: format(max) }) +
      (pct > 100 ? ` · ${t("limits.over", { amount: format(used - max) })}` : "");

    return `<div class="lim ${tone}" title="${esc(tip)}">
      <i style="width:${width}%"></i>
      <span class="lim-l">${esc(label)}</span>
      <span class="lim-v">${esc(format(used))} / ${esc(format(max))}</span>
      <span class="lim-p">${pct}%</span>
    </div>`;
  }).filter(Boolean);

  el.limits.innerHTML = rows.length
    ? `<div class="lims">${rows.join("")}</div>`
    : `<p class="empty">${esc(t("limits.none"))}</p>`;
}

function renderCoverage(settled) {
  if (settled.status !== "fulfilled") {
    el.coverage.innerHTML = "";
    return;
  }
  const pct = settled.value.records?.[0]?.PercentCovered;
  if (typeof pct !== "number") {
    el.coverage.innerHTML = "";
    return;
  }
  // 75% is the deployment gate, so that is the line that matters.
  const tone = pct >= 75 ? "ok" : "bad";
  el.coverage.innerHTML = `<div class="cov ${tone}">
    <span>${esc(t("coverage.label"))}</span>
    <span class="bar"><i class="${tone}" style="width:${Math.min(100, pct)}%"></i></span>
    <span class="cov-n">${pct}%</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// rendering: KPIs
// ---------------------------------------------------------------------------

function renderKpis(results, fatal) {
  const tiles = el.kpis.querySelectorAll(".kpi");

  if (fatal) {
    tiles.forEach(tile => {
      tile.querySelector(".kpi-n").textContent = "!";
      tile.classList.remove("hot");
    });
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
      n.textContent = fmt.number(count);
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
// progress sampling
// ---------------------------------------------------------------------------

/**
 * Throughput samples, collected across refreshes and keyed per unit of work
 * (a job id, or a deployment id plus its phase).
 *
 * Neither source gives us a clean "started processing" timestamp: AsyncApexJob's
 * CreatedDate is when the job was *queued*, and a deployment's StartDate covers
 * earlier phases too. Both make a naive done/elapsed rate too pessimistic, so once
 * we have watched something across two polls we use the rate we measured instead.
 */
const MIN_SAMPLE_SPAN_MS = 10000;
const jobSamples = new Map();
const deploySamples = new Map();

function sampleProgress(map, key, n, now) {
  const existing = map.get(key);
  if (!existing) {
    const fresh = { firstT: now, firstN: n, lastT: now, lastN: n };
    map.set(key, fresh);
    return fresh;
  }
  existing.lastT = now;
  existing.lastN = n;
  return existing;
}

function pruneSamples(map, liveKeys) {
  map.forEach((_, key) => {
    if (!liveKeys.has(key)) map.delete(key);
  });
}

/** Remaining-time estimate from a done/total pair. Null when it cannot be guessed. */
function estimateFinish(map, { key, done, total, startedAt, now }) {
  if (!total || done >= total) return null;

  const sample = sampleProgress(map, key, done, now);
  const span = sample.lastT - sample.firstT;
  const delta = sample.lastN - sample.firstN;

  let rate = null;      // units per ms
  let measured = false;
  if (span >= MIN_SAMPLE_SPAN_MS && delta > 0) {
    rate = delta / span;
    measured = true;
  } else {
    const elapsed = now - Date.parse(startedAt);
    if (elapsed > 0 && done > 0) rate = done / elapsed;
  }
  if (!rate || !Number.isFinite(rate)) return null;

  const remainingMs = (total - done) / rate;
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;

  return { remainingMs, finishAt: new Date(now + remainingMs), measured };
}

// ---------------------------------------------------------------------------
// rendering: running jobs
// ---------------------------------------------------------------------------

function renderRunningJobs(detail, countResult) {
  if (!detail.ok) {
    el.runningJobs.innerHTML =
      `<p class="jobs-more">${esc(t("jobs.detailUnavailable", { error: detail.error.message }))}</p>`;
    return;
  }

  const jobs = detail.value.records || [];
  pruneSamples(jobSamples, new Set(jobs.map(j => j.Id)));

  if (jobs.length === 0) {
    el.runningJobs.innerHTML = "";
    return;
  }

  const now = Date.now();
  const total = countResult?.ok ? countResult.value.totalSize ?? jobs.length : jobs.length;
  const hidden = total - jobs.length;

  el.runningJobs.innerHTML =
    `<div class="jobs">${jobs.map(j => jobRow(j, now)).join("")}</div>` +
    (hidden > 0 ? `<p class="jobs-more">${esc(t("jobs.more", { count: hidden }))}</p>` : "");
}

function jobRow(job, now) {
  const name = job.ApexClass?.Name || t("jobs.classUnavailable");
  const method = job.MethodName ? `<span class="method">.${esc(job.MethodName)}</span>` : "";
  const who = job.CreatedBy?.Name;

  const total = Number(job.TotalJobItems) || 0;
  const done = Number(job.JobItemsProcessed) || 0;
  const errors = Number(job.NumberOfErrors) || 0;

  const eta = estimateFinish(jobSamples, {
    key: job.Id, done, total, startedAt: job.CreatedDate, now,
  });

  const parts = [
    `<div class="job">`,
    `<div class="job-top">`,
    `<span class="job-name">${esc(name)}${method}</span>`,
    `<span class="job-type">${esc(prettyJobType(job.JobType))}</span>`,
    `</div>`,
    `<div class="job-meta">`,
    who ? `<span>${esc(t("jobs.by", { name: who }))}</span>` : "",
    `<span>${esc(t("jobs.started", { when: fmt.relative(job.CreatedDate) }))}</span>`,
    job.Status === "Preparing" ? `<span>${esc(t("jobs.preparing"))}</span>` : "",
    errors > 0 ? `<span class="job-errs">${esc(t("jobs.errors", { count: errors }))}</span>` : "",
    `</div>`,
  ];

  if (total > 0) parts.push(progressBar(t("jobs.batches"), done, total, errors));

  if (eta) {
    const basis = eta.measured ? t("jobs.etaMeasured") : t("jobs.etaFallback");
    parts.push(
      `<p class="job-eta" title="${esc(basis)}">` +
      `${esc(t("jobs.etaLeft", { duration: fmt.duration(eta.remainingMs) }))} ` +
      `<span class="soft">· ${esc(t("jobs.doneAround", { time: fmt.time(eta.finishAt) }))}` +
      `${eta.measured ? "" : ` ${esc(t("jobs.rough"))}`}</span></p>`
    );
  }

  if (job.ExtendedStatus) parts.push(`<p class="job-ext">${esc(job.ExtendedStatus)}</p>`);

  parts.push(`</div>`);
  return parts.join("");
}

const prettyJobType = type => tOr(`jobType.${type}`, type || t("jobType.default"));

// ---------------------------------------------------------------------------
// rendering: failed jobs
// ---------------------------------------------------------------------------

function renderFailedJobs(result) {
  if (!result.ok) {
    el.failedJobs.innerHTML = "";
    return;
  }
  const jobs = result.value.records || [];
  if (jobs.length === 0) {
    el.failedJobs.innerHTML = "";
    return;
  }

  el.failedJobs.innerHTML = `
    <details class="group bad" ${detailsAttr("failed-jobs")}>
      <summary>${esc(t("jobs.failedRecent"))} <span class="count">${fmt.number(jobs.length)}</span></summary>
      ${jobs.map(j => `
        <div class="cron">
          <div class="cron-top">
            <span class="cron-name">${esc(j.ApexClass?.Name || t("jobs.classUnavailable"))}${
              j.MethodName ? `.${esc(j.MethodName)}` : ""}</span>
            <span class="cron-state bad">${esc(prettyJobType(j.JobType))}</span>
          </div>
          <div class="cron-meta">
            <span>${esc(fmt.relative(j.CompletedDate))}</span>
            ${Number(j.NumberOfErrors) > 0
              ? `<span>${esc(t("jobs.errors", { count: Number(j.NumberOfErrors) }))}</span>` : ""}
            ${Number(j.TotalJobItems) > 0
              ? `<span>${esc(t("jobs.batchesOf", {
                  done: fmt.number(j.JobItemsProcessed), total: fmt.number(j.TotalJobItems),
                }))}</span>` : ""}
          </div>
          ${j.ExtendedStatus ? `<div class="cron-meta">${esc(j.ExtendedStatus)}</div>` : ""}
        </div>`).join("")}
    </details>`;
}

// ---------------------------------------------------------------------------
// rendering: scheduled jobs
// ---------------------------------------------------------------------------

const BAD_CRON_STATES = new Set(["ERROR", "PAUSED", "PAUSED_BLOCKED", "BLOCKED"]);

function renderScheduledJobs(result, countResult) {
  if (!result.ok) {
    el.scheduledJobs.innerHTML = "";
    return;
  }
  const rows = result.value.records || [];
  if (rows.length === 0) {
    el.scheduledJobs.innerHTML = "";
    return;
  }

  const total = countResult?.ok ? countResult.value.totalSize ?? rows.length : rows.length;
  const unhealthy = rows.filter(r => BAD_CRON_STATES.has(r.State)).length;

  // Closed by default - a production org can carry dozens of these.
  el.scheduledJobs.innerHTML = `
    <details class="group ${unhealthy ? "bad" : ""}" ${detailsAttr("scheduled-jobs")}>
      <summary>
        ${esc(t("jobs.scheduledList"))} <span class="count">${fmt.number(total)}</span>
        ${unhealthy
          ? `<span class="count">${esc(t("jobs.needAttention", { count: unhealthy }))}</span>` : ""}
      </summary>
      ${rows.map(cronRow).join("")}
      ${total > rows.length
        ? `<p class="jobs-more">${esc(t("jobs.more", { count: total - rows.length }))}</p>` : ""}
    </details>`;
}

function cronRow(c) {
  const state = c.State || "";
  const tone = BAD_CRON_STATES.has(state) ? (state === "ERROR" ? "bad" : "hold") : "";
  return `<div class="cron">
    <div class="cron-top">
      <span class="cron-name">${esc(c.CronJobDetail?.Name || t("jobs.unnamed"))}</span>
      <span class="cron-state ${tone}">${esc(tOr(`cron.${state}`, state.replace(/_/g, " ")))}</span>
    </div>
    <div class="cron-meta">
      <span>${esc(t("jobs.next", { when: c.NextFireTime ? fmt.absoluteShort(c.NextFireTime) : "—" }))}</span>
      <span>${esc(t("jobs.last", { when: c.PreviousFireTime ? fmt.relative(c.PreviousFireTime) : t("common.never") }))}</span>
      <span>${esc(t("jobs.runs", { count: Number(c.TimesTriggered) || 0 }))}</span>
      ${c.CronExpression ? `<span><code>${esc(c.CronExpression)}</code></span>` : ""}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// rendering: debug logs
// ---------------------------------------------------------------------------

let logCount = 0;
let purgeArmed = false;
let purgeTimer = null;
// Survives the re-render that a post-purge refresh triggers, so the result of a
// destructive action does not vanish a second after it finishes.
let purgeMessage = "";

function renderLogs(countResult, sizeResult) {
  if (!countResult.ok) {
    el.logs.innerHTML =
      `<p class="empty">${esc(t("logs.unavailable", { error: countResult.error.message }))}</p>`;
    return;
  }

  logCount = countResult.value.totalSize ?? 0;
  // SUM(LogLength) is not supported everywhere; the count alone is still useful.
  const bytes = sizeResult.ok ? sizeResult.value.records?.[0]?.total : null;
  const size = typeof bytes === "number" ? ` <span class="sub">· ${esc(fmt.bytes(bytes))}</span>` : "";

  el.logs.innerHTML = `
    <div class="logline">
      <span class="grow"><b>${esc(t("logs.count", { count: logCount }))}</b>${size}</span>
      <button class="danger-btn" data-action="purge-logs" ${logCount ? "" : "disabled"}
        >${esc(t("logs.deleteAll"))}</button>
    </div>
    <div class="log-progress" id="logProgress" ${purgeMessage ? "" : "hidden"}>${esc(purgeMessage)}</div>`;

  purgeArmed = false;
}

function onPurgeClick() {
  const btn = el.logs.querySelector('[data-action="purge-logs"]');
  if (!btn || btn.disabled) return;

  // Two-step confirm: this is irreversible and there is no undo in Salesforce.
  if (!purgeArmed) {
    purgeArmed = true;
    btn.classList.add("confirm");
    btn.textContent = t("logs.confirm", { count: logCount });
    clearTimeout(purgeTimer);
    purgeTimer = setTimeout(() => {
      purgeArmed = false;
      btn.classList.remove("confirm");
      btn.textContent = t("logs.deleteAll");
    }, 5000);
    return;
  }

  clearTimeout(purgeTimer);
  purgeArmed = false;
  runPurge(btn);
}

async function runPurge(btn) {
  const progress = document.getElementById("logProgress");
  const total = logCount;
  purgeMessage = "";
  btn.disabled = true;
  btn.classList.remove("confirm");
  btn.textContent = t("logs.deleting");
  progress.hidden = false;
  progress.textContent = t("logs.starting");

  try {
    const { deleted, failed } = await purgeApexLogs((done, bad) => {
      progress.textContent =
        t("logs.progress", { done: fmt.number(done), total: fmt.number(total) }) +
        (bad ? ` · ${t("logs.refused", { count: bad })}` : "");
    });
    purgeMessage = t("logs.done", { count: deleted }) +
      (failed ? ` ${t("logs.someFailed", { count: failed })}` : "");
  } catch (err) {
    purgeMessage = t("logs.failed", { error: err.message });
  } finally {
    progress.textContent = purgeMessage;
    btn.disabled = false;
    btn.textContent = t("logs.deleteAll");
    await refreshJobs(); // re-renders with the new count, keeping purgeMessage
  }
}

/**
 * ApexLog cannot be deleted with Apex DML, so it goes through the REST API in
 * pages of 200. composite/sobjects handles the whole page in one call; if the org
 * refuses that for ApexLog we fall back to individual deletes.
 */
async function purgeApexLogs(onProgress) {
  const v = await client.apiVersion();
  let deleted = 0;
  let failed = 0;

  for (;;) {
    const page = await client.query("SELECT Id FROM ApexLog LIMIT 200");
    const ids = (page.records || []).map(r => r.Id);
    if (ids.length === 0) break;

    const res = await deleteRecords(ids, v);
    deleted += res.ok;
    failed += res.failed;
    onProgress(deleted, failed);

    // Nothing in this page could be removed - stop rather than spin forever.
    if (res.ok === 0) break;
  }

  return { deleted, failed };
}

async function deleteRecords(ids, v) {
  try {
    const res = await client.request(
      `/services/data/v${v}/composite/sobjects?ids=${ids.join(",")}&allOrNone=false`,
      { method: "DELETE" }
    );
    const arr = toArray(res);
    return {
      ok: arr.filter(x => x.success).length,
      failed: arr.filter(x => !x.success).length,
    };
  } catch {
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < ids.length; i += 10) {
      const settled = await Promise.allSettled(
        ids.slice(i, i + 10).map(id =>
          client.request(`/services/data/v${v}/sobjects/ApexLog/${id}`, { method: "DELETE" })
        )
      );
      ok += settled.filter(s => s.status === "fulfilled").length;
      failed += settled.filter(s => s.status === "rejected").length;
    }
    return { ok, failed };
  }
}

// ---------------------------------------------------------------------------
// rendering: deployments
// ---------------------------------------------------------------------------

async function renderDeployments(settled) {
  if (settled.status === "rejected") {
    lastDeploys = [];
    el.deploy.innerHTML =
      `<p class="empty">${esc(t("deploy.readError", { error: settled.reason.message }))}</p>`;
    return;
  }

  lastDeploys = settled.value;
  pruneSamples(
    deploySamples,
    new Set(lastDeploys.flatMap(d => [`${d.Id}:tests`, `${d.Id}:components`]))
  );

  if (lastDeploys.length === 0) {
    el.deploy.innerHTML = `<p class="empty">${esc(t("deploy.none"))}</p>`;
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
      ? `<details class="recent" ${detailsAttr("recent-deploys")}>
           <summary>${esc(t("deploy.earlier", { count: rest.length }))}</summary>
           ${rest.map(recentRow).join("")}
         </details>`
      : "");
}

function deployCard(d, details) {
  const look = statusLook(d.Status);
  const kind = d.CheckOnly ? t("deploy.validation") : t("deploy.deployment");
  const who = d.CreatedBy?.Name ? ` · ${esc(d.CreatedBy.Name)}` : "";
  const active = isActive(d);

  const parts = [
    `<div class="card ${active ? "active" : ""}">`,
    `<div class="card-top">`,
    `<span class="pill ${look.tone}">${esc(look.label)}</span>`,
    `<span style="font-weight:600">${esc(kind)}</span>`,
    `<span class="tagline">${esc(timeSummary(d))}</span>`,
    `</div>`,
    `<div class="card-meta">`,
    `<span>${esc(shortId(d.Id))}${who}</span>`,
    d.TestLevel ? `<span>${esc(t("deploy.testLevel", { level: d.TestLevel }))}</span>` : "",
    `</div>`,
  ];

  if (d.NumberComponentsTotal > 0) {
    parts.push(progressBar(t("deploy.components"), d.NumberComponentsDeployed,
      d.NumberComponentsTotal, d.NumberComponentErrors));
  }
  if (d.NumberTestsTotal > 0) {
    parts.push(progressBar(t("deploy.tests"), d.NumberTestsCompleted,
      d.NumberTestsTotal, d.NumberTestErrors));
  }

  if (active) {
    parts.push(deployEtaLine(d, Date.now()));
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
      `<details class="errs" ${detailsAttr(`failures:${d.Id}`, true)}>`,
      `<summary>${esc(t("deploy.failures", { count: failures.length }))}</summary>`,
      failures.map(f => `<div class="err-item"><b>${esc(f.title)}</b><span>${esc(f.body)}</span></div>`).join(""),
      `</details>`
    );
  } else if (details instanceof Error) {
    parts.push(`<p class="state-detail">${esc(t("deploy.detailsUnavailable", { error: details.message }))}</p>`);
  }

  parts.push(`<div class="card-actions">
    <button class="chip" data-deploy-setup="${esc(d.Id)}">${esc(t("deploy.openSetup"))}</button>
    <button class="chip" data-copy="${esc(d.Id)}">${esc(t("deploy.copyId"))}</button>
    <button class="chip" data-copy="${esc(sfCommand(d.Id))}">${esc(t("deploy.copySf"))}</button>
  </div>`);

  parts.push(`</div>`);
  return parts.join("");
}

const sfCommand = id => `sf project deploy report --job-id ${id}`;

/**
 * Remaining time for a running deployment.
 *
 * Deployments run components first, then tests, and tests usually dominate the
 * wall clock - so estimating off a combined total would be meaningless. Whichever
 * phase is currently moving is the one we project, and while components are still
 * going we say so rather than implying the whole deploy ends there.
 */
function deployEtaLine(d, now) {
  const testsTotal = Number(d.NumberTestsTotal) || 0;
  const testsDone = Number(d.NumberTestsCompleted) || 0;
  const compTotal = Number(d.NumberComponentsTotal) || 0;
  const compDone = Number(d.NumberComponentsDeployed) || 0;
  const startedAt = d.StartDate || d.CreatedDate;

  let eta = null;
  let phase = "";
  let trailing = "";

  if (testsTotal > 0 && testsDone < testsTotal) {
    phase = t("deploy.phase.tests");
    eta = estimateFinish(deploySamples, {
      key: `${d.Id}:tests`, done: testsDone, total: testsTotal, startedAt, now,
    });
  } else if (compTotal > 0 && compDone < compTotal) {
    phase = t("deploy.phase.components");
    eta = estimateFinish(deploySamples, {
      key: `${d.Id}:components`, done: compDone, total: compTotal, startedAt, now,
    });
    const testsFollow = d.RunTestsEnabled === true ||
      (d.TestLevel && d.TestLevel !== "NoTestRun");
    if (testsFollow) trailing = ` · ${t("deploy.testsStillToRun")}`;
  }

  if (!eta) return "";

  const basis = eta.measured ? t("deploy.etaMeasured") : t("deploy.etaRough");
  return `<p class="job-eta" title="${esc(basis)}">` +
    `${esc(t("deploy.etaLeft", { duration: fmt.duration(eta.remainingMs), phase }))} ` +
    `<span class="soft">· ${esc(fmt.time(eta.finishAt))}${esc(trailing)}` +
    `${eta.measured ? "" : ` ${esc(t("jobs.rough"))}`}</span></p>`;
}

const ROW_ICONS = {
  setup: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 3.2h6.4v6.4"/><path d="M12.8 3.2 6 10M9.6 12.8H3.2V6.4"/></svg>`,
  copy: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="5.6" y="5.6" width="8.2" height="8.2" rx="1.2"/><path d="M10.6 5.6v-2a1.2 1.2 0 0 0-1.2-1.2H3.4a1.2 1.2 0 0 0-1.2 1.2v6a1.2 1.2 0 0 0 1.2 1.2h2"/></svg>`,
  cli: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.6" y="2.8" width="12.8" height="10.4" rx="1.4"/><path d="M4.6 6.6 6.6 8.6l-2 2M8.8 10.8h2.8"/></svg>`,
};

function recentRow(d) {
  const look = statusLook(d.Status);
  return `<div class="recent-row">
    <span class="pill ${look.tone}">${esc(look.label)}</span>
    <span>${esc(d.CheckOnly ? t("deploy.validation") : t("deploy.deployShort"))}</span>
    <span class="when">${esc(fmt.relative(d.CompletedDate || d.StartDate || d.CreatedDate))}</span>
    <span class="row-tools">
      <button class="icon-chip" data-deploy-setup="${esc(d.Id)}"
        title="${esc(t("deploy.openSetup"))}">${ROW_ICONS.setup}</button>
      <button class="icon-chip" data-copy="${esc(d.Id)}"
        title="${esc(t("deploy.copyIdTitle"))}">${ROW_ICONS.copy}</button>
      <button class="icon-chip" data-copy="${esc(sfCommand(d.Id))}"
        title="${esc(t("deploy.copySf"))}">${ROW_ICONS.cli}</button>
    </span>
  </div>`;
}

function progressBar(label, done, total, errors) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const tone = errors > 0 ? "err" : pct === 100 ? "ok" : "";
  const errText = errors > 0 ? ` · ${t("jobs.errors", { count: Number(errors) })}` : "";
  return `<div class="bar-row">
    <div class="bar-lab">
      <span>${esc(label)} <b>${pct}%</b></span>
      <span>${esc(fmt.number(done ?? 0))}/${esc(fmt.number(total))}${esc(errText)}</span>
    </div>
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
    const where = f.lineNumber
      ? ` (${t("deploy.atLine", { line: f.lineNumber })}${
          f.columnNumber ? `, ${t("deploy.atColumn", { column: f.columnNumber })}` : ""})`
      : "";
    out.push({
      title: `${f.componentType || t("deploy.componentLabel")}: ${f.fullName || f.fileName || "?"}${where}`,
      body: f.problem || "",
    });
  }

  const tests = d.runTestResult || {};
  for (const f of toArray(tests.failures).slice(0, 20)) {
    out.push({
      title: `${t("deploy.testLabel")}: ${f.name || "?"}.${f.methodName || ""}`,
      body: [f.message, f.stackTrace].filter(Boolean).join("\n"),
    });
  }

  return out;
}

const STATUS_TONES = {
  Succeeded: "ok",
  SucceededPartial: "warn",
  Failed: "err",
  Canceled: "idle",
  Canceling: "warn",
  InProgress: "run",
  Pending: "run",
};

function statusLook(status) {
  if (!status) return { label: t("status.unknown"), tone: "idle" };
  return { label: tOr(`status.${status}`, status), tone: STATUS_TONES[status] || "idle" };
}

// ---------------------------------------------------------------------------
// rendering: shortcuts and record jump
// ---------------------------------------------------------------------------

const SC_ICONS = {
  devconsole: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.4"/><path d="M4.6 6.6 6.6 8.6l-2 2M8.6 10.6h3"/></svg>`,
  apex: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.8 3.4 9h3.4l-.8 5.2L12.6 7H9.2z"/></svg>`,
  path: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 3.2h6.4v6.4"/><path d="M12.8 3.2 6 10M9.6 12.8H3.2V6.4"/></svg>`,
};

async function renderShortcuts() {
  const list = await loadShortcuts();
  el.shortcuts.innerHTML = list.map(s => {
    const label = esc(shortcutLabel(s));
    if (s.kind === "devconsole") return `<button class="sc" data-devconsole>${SC_ICONS.devconsole}${label}</button>`;
    if (s.kind === "apex") return `<button class="sc" data-apexrunner>${SC_ICONS.apex}${label}</button>`;
    if (!s.path) return "";
    return `<button class="sc" data-setup="${esc(s.path)}">${SC_ICONS.path}${label}</button>`;
  }).join("");
}

/**
 * Record Id lookup. The first three characters of a Salesforce Id identify the
 * object, and the global describe hands us the whole prefix table in one call.
 */
async function keyPrefixMap() {
  const cacheKey = `prefixes:${client.host}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);

  const v = await client.apiVersion();
  const res = await client.request(`/services/data/v${v}/sobjects/`);
  const map = {};
  for (const s of res.sobjects || []) {
    if (s.keyPrefix && !map[s.keyPrefix]) map[s.keyPrefix] = s.name;
  }
  sessionStorage.setItem(cacheKey, JSON.stringify(map));
  return map;
}

let jumpTarget = null;

async function onJumpInput() {
  const raw = el.jumpInput.value.trim();
  jumpTarget = null;

  if (!raw) {
    el.jumpHint.textContent = "";
    el.jumpHint.classList.remove("bad");
    return;
  }
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(raw)) {
    el.jumpHint.textContent = t("jump.badLength");
    el.jumpHint.classList.add("bad");
    return;
  }

  el.jumpHint.classList.remove("bad");
  el.jumpHint.textContent = t("jump.lookingUp");

  try {
    const map = await keyPrefixMap();
    const name = map[raw.slice(0, 3)];
    if (!name) {
      el.jumpHint.textContent = t("jump.unknownPrefix", { prefix: raw.slice(0, 3) });
      el.jumpHint.classList.add("bad");
      return;
    }
    jumpTarget = { name, id: raw };
    el.jumpHint.textContent = t("jump.ready", { object: name });
  } catch (err) {
    el.jumpHint.textContent = err.message;
    el.jumpHint.classList.add("bad");
  }
}

function onJumpKey(ev) {
  if (ev.key !== "Enter" || !jumpTarget || !session) return;
  openTab(`https://${session.lightningHost}/lightning/r/${jumpTarget.name}/${jumpTarget.id}/view`);
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

function timeSummary(d) {
  if (isActive(d)) {
    const start = Date.parse(d.StartDate || d.CreatedDate);
    return Number.isNaN(start)
      ? t("status.InProgress")
      : t("deploy.running", { duration: fmt.duration(Date.now() - start) });
  }
  const end = d.CompletedDate || d.StartDate || d.CreatedDate;
  const start = Date.parse(d.StartDate || d.CreatedDate);
  const finish = Date.parse(end);
  const took = !Number.isNaN(start) && !Number.isNaN(finish) && finish > start
    ? ` · ${fmt.duration(finish - start)}`
    : "";
  return `${fmt.relative(end)}${took}`;
}

const shortId = id => (id || "").slice(0, 15);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be refused inside a cross-origin iframe; fall back.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Icon-only buttons flash a colour; text buttons swap their label. */
function flash(button, message) {
  if (button.querySelector("svg")) {
    button.classList.add("done");
    setTimeout(() => button.classList.remove("done"), 1200);
    return;
  }
  const original = button.textContent;
  button.textContent = message;
  button.classList.add("done");
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("done");
  }, 1200);
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
    console.warn("[Orgscope] update check failed:", err.message);
    return;
  }

  if (!info.configured || !info.outdated) {
    el.updateBanner.hidden = true;
    return;
  }

  const { updateDismissed } = await chrome.storage.local.get("updateDismissed");
  if (!force && updateDismissed === info.latest) return;

  el.updateBanner.innerHTML = `
    <div class="banner-title">${esc(t("update.title", { version: info.latest }))}</div>
    <div class="banner-body">${
      t("update.body", { current: esc(info.current), cmd: "<code>git pull</code>" })
    }</div>
    <div class="banner-actions">
      <button class="banner-btn" data-action="reload-ext">${esc(t("stale.reload"))}</button>
      <button class="banner-btn" data-href="${esc(info.commitsUrl)}">${esc(t("update.whatChanged"))}</button>
      <button class="banner-btn" data-action="dismiss-update"
              data-version="${esc(info.latest)}">${esc(t("update.dismiss"))}</button>
    </div>`;
  el.updateBanner.hidden = false;
}

// ---------------------------------------------------------------------------
// interactions
// ---------------------------------------------------------------------------

document.addEventListener("click", async ev => {
  const link = ev.target.closest("[data-href]");
  if (link) {
    openTab(link.dataset.href);
    return;
  }

  const copySource = ev.target.closest("[data-copy]");
  if (copySource) {
    const ok = await copyText(copySource.dataset.copy);
    flash(copySource, ok ? t("common.copied") : t("common.copyFailed"));
    return;
  }

  const deploySetup = ev.target.closest("[data-deploy-setup]");
  if (deploySetup && session) {
    const inner = `/changemgmt/monitorDeploymentsDetails.apexp?asyncId=${deploySetup.dataset.deploySetup}`;
    openTab(`https://${session.lightningHost}/lightning/setup/DeployStatus/page?address=${encodeURIComponent(inner)}`);
    return;
  }

  const actionEl = ev.target.closest("[data-action]");
  const action = actionEl?.dataset.action;
  if (action === "reload-ext") {
    // The panel dies with the extension context, so say what happens next first.
    el.updateBanner.innerHTML =
      `<div class="banner-title">${esc(t("update.reloading"))}</div>
       <div class="banner-body">${esc(t("update.reloadingBody"))}</div>`;
    el.updateBanner.hidden = false;
    bg("reloadExtension").catch(() => {});
    return;
  }
  if (action === "dismiss-update") {
    chrome.storage.local.set({ updateDismissed: actionEl.dataset.version });
    el.updateBanner.hidden = true;
    return;
  }
  if (action === "purge-logs") {
    onPurgeClick();
    return;
  }

  const setupTarget = ev.target.closest("[data-setup]");
  if (setupTarget) {
    ev.preventDefault();
    if (!session) return;
    openTab(`https://${session.lightningHost}${setupTarget.dataset.setup}`);
    return;
  }

  if (ev.target.closest("[data-devconsole]") && session) {
    openTab(`https://${session.apiHost}/_ui/common/apex/debug/ApexCSIPage`);
    return;
  }

  if (ev.target.closest("[data-apexrunner]")) {
    bg("openApexRunner", { host: pageHost }).catch(reportBgError);
  }
});

const openOptions = () => bg("openOptions").catch(reportBgError);

el.refreshDeploy.addEventListener("click", () => refreshDeploys());
el.refreshJobs.addEventListener("click", () => refreshJobs());
el.refreshOrg.addEventListener("click", ev => {
  // The button lives inside a <summary>; without this the section folds instead.
  ev.preventDefault();
  ev.stopPropagation();
  refreshLimits();
  refreshOrgMeta();
});
el.refreshAll.addEventListener("click", () => {
  el.refreshAll.classList.add("spin");
  Promise.all([
    refreshDeploys(), refreshJobs(), refreshLimits(), refreshOrgMeta(),
    checkForUpdate({ force: true }),
  ]).finally(() => el.refreshAll.classList.remove("spin"));
});
el.close.addEventListener("click", () => toHost({ type: "close" }));
el.optionsBtn.addEventListener("click", openOptions);
el.editShortcuts.addEventListener("click", openOptions);
el.jumpInput.addEventListener("input", onJumpInput);
el.jumpInput.addEventListener("keydown", onJumpKey);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[SHORTCUTS_KEY]) renderShortcuts();
});

// A language switch touches every rendered string, so start the panel over
// rather than trying to re-translate what is already on screen.
onLocaleChanged(() => location.reload());

window.addEventListener("message", ev => {
  const msg = ev.data;
  if (msg?.source !== "orgscope-host") return;
  if (msg.type !== "visibility") return;

  const wasHidden = !visible;
  visible = msg.visible;

  if (!visible) {
    clearTimeout(deployTimer);
    clearTimeout(jobsTimer);
    clearTimeout(limitsTimer);
    updatePollNote();
  } else if (wasHidden) {
    refreshDeploys();
    refreshJobs();
    refreshLimits();
  }
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function init() {
  toHost({ type: "ready" });

  await initI18n();
  applyStaticText();

  el.orgName.title = `v${chrome.runtime.getManifest().version}`;
  renderShortcuts();
  checkForUpdate(); // fire and forget - never blocks the org data

  try {
    session = await bg("getSession", { host: pageHost });
  } catch (err) {
    el.orgHost.textContent = t("common.notConnected");
    el.deploy.innerHTML = "";
    el.limits.innerHTML = "";
    reportBgError(err);
    return;
  }

  client = new SalesforceClient(session.apiHost, session.sessionId);
  el.orgHost.textContent = session.apiHost;
  el.orgHost.title = `${session.apiHost} · org ${session.orgId}`;

  await Promise.all([refreshDeploys(), refreshJobs(), refreshLimits(), refreshOrgMeta()]);
}

init();
