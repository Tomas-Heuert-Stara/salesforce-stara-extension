/**
 * Panel app. Runs on the extension origin inside an iframe on the Salesforce page,
 * so it can call the org's REST/Tooling API directly using the session id the
 * service worker digs out of the cookie jar.
 *
 * Three independent refresh cycles:
 *   deploys - 4s while one is running, 30s otherwise
 *   jobs    - 30s, everything in one composite/batch call
 *   org     - once at boot and on demand (limits, coverage, org identity)
 */

import { loadShortcuts, SHORTCUTS_KEY } from "./shortcuts.js";

const POLL_DEPLOY_ACTIVE_MS = 4000;
const POLL_DEPLOY_IDLE_MS = 30000;
const POLL_JOBS_MS = 30000;

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
let deployBusy = false;
let jobsBusy = false;
let orgBusy = false;
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
    const r = await client.batch([
      soqlPath(Q_SCHEDULED),
      soqlPath(Q_RUNNING),
      soqlPath(Q_FLEX),
      soqlPath(runningDetailQuery()),
      soqlPath(Q_SCHEDULED_DETAIL),
      soqlPath(failedJobsQuery()),
      soqlPath(Q_LOG_COUNT),
      soqlPath(Q_LOG_SIZE),
      "limits",
    ]);

    if (r.some(x => !x.ok && isAuthError(x.error))) {
      showBanner("Salesforce session expired. Reload the page and try again.");
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
    renderLimits(r[8]);
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

/** Org identity and code coverage: slow-moving, so no timer - boot and on demand. */
async function refreshOrg() {
  if (orgBusy || !client) return;
  orgBusy = true;
  el.refreshOrg.classList.add("spin");

  const [org, coverage] = await Promise.allSettled([
    client.query(Q_ORG),
    client.query(Q_COVERAGE, { tooling: true }),
  ]);

  if (org.status === "fulfilled") renderOrgIdentity(org.value.records?.[0]);
  renderCoverage(coverage);

  orgBusy = false;
  el.refreshOrg.classList.remove("spin");
}

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
// rendering: org identity, limits, coverage
// ---------------------------------------------------------------------------

function renderOrgIdentity(org) {
  if (!org) return;
  el.orgName.textContent = org.Name || "Stara SF Toolbox";
  el.orgName.title = `${org.Name || ""} · ${org.OrganizationType || ""} · ${org.InstanceName || ""}` +
    ` · v${chrome.runtime.getManifest().version}`;
  el.envBadge.textContent = org.IsSandbox ? "Sandbox" : "Prod";
  el.envBadge.className = `env ${org.IsSandbox ? "sandbox" : "prod"}`;
  el.envBadge.hidden = false;
}

// Only the limits worth watching day to day; /limits returns dozens.
const WATCHED_LIMITS = [
  ["DailyApiRequests", "Daily API requests", "n"],
  ["DailyAsyncApexExecutions", "Daily async Apex", "n"],
  ["DataStorageMB", "Data storage", "mb"],
  ["FileStorageMB", "File storage", "mb"],
  ["SingleEmail", "Single email", "n"],
  ["MassEmail", "Mass email", "n"],
  ["HourlyTimeBasedWorkflow", "Hourly time-based WF", "n"],
];

function renderLimits(result) {
  if (!result.ok) {
    el.limits.innerHTML = `<p class="empty">Limits unavailable: ${esc(result.error.message)}</p>`;
    return;
  }

  const data = result.value || {};
  const rows = WATCHED_LIMITS.map(([key, label, unit]) => {
    const lim = data[key];
    if (!lim || typeof lim.Max !== "number") return "";

    const max = lim.Max;
    const used = max - (lim.Remaining ?? 0);
    const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
    const tone = pct >= 90 ? "bad" : pct >= 75 ? "warn" : "";
    const fmt = unit === "mb" ? formatMb : formatNumber;

    return `<div class="lim ${tone}" title="${esc(label)}: ${used} of ${max}">
      <i style="width:${pct}%"></i>
      <span class="lim-l">${esc(label)}</span>
      <span class="lim-v">${fmt(used)} / ${fmt(max)}</span>
      <span class="lim-p">${pct}%</span>
    </div>`;
  }).filter(Boolean);

  el.limits.innerHTML = rows.length
    ? `<div class="lims">${rows.join("")}</div>`
    : `<p class="empty">No matching limits returned by this org.</p>`;
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
    <span>Apex coverage</span>
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
const MIN_SAMPLE_SPAN_MS = 10000;

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

  if (total > 0) parts.push(progressBar("Batches", done, total, errors));

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

  if (job.ExtendedStatus) parts.push(`<p class="job-ext">${esc(job.ExtendedStatus)}</p>`);

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
    <details class="group bad">
      <summary>Failed in the last 24h <span class="count">${jobs.length}</span></summary>
      ${jobs.map(j => `
        <div class="cron">
          <div class="cron-top">
            <span class="cron-name">${esc(j.ApexClass?.Name || "(class unavailable)")}${
              j.MethodName ? `.${esc(j.MethodName)}` : ""}</span>
            <span class="cron-state bad">${esc(prettyJobType(j.JobType))}</span>
          </div>
          <div class="cron-meta">
            <span>${esc(relative(j.CompletedDate))}</span>
            ${Number(j.NumberOfErrors) > 0 ? `<span>${j.NumberOfErrors} errors</span>` : ""}
            ${Number(j.TotalJobItems) > 0
              ? `<span>${j.JobItemsProcessed}/${j.TotalJobItems} batches</span>` : ""}
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
    <details class="group ${unhealthy ? "bad" : ""}">
      <summary>
        Scheduled jobs <span class="count">${total}</span>
        ${unhealthy ? `<span class="count">${unhealthy} need attention</span>` : ""}
      </summary>
      ${rows.map(cronRow).join("")}
      ${total > rows.length ? `<p class="jobs-more">+ ${total - rows.length} more not shown</p>` : ""}
    </details>`;
}

function cronRow(c) {
  const state = c.State || "";
  const tone = BAD_CRON_STATES.has(state) ? (state === "ERROR" ? "bad" : "hold") : "";
  return `<div class="cron">
    <div class="cron-top">
      <span class="cron-name">${esc(c.CronJobDetail?.Name || "(unnamed)")}</span>
      <span class="cron-state ${tone}">${esc(state.replace(/_/g, " "))}</span>
    </div>
    <div class="cron-meta">
      <span>next ${esc(c.NextFireTime ? absoluteShort(c.NextFireTime) : "—")}</span>
      <span>last ${esc(c.PreviousFireTime ? relative(c.PreviousFireTime) : "never")}</span>
      <span>${c.TimesTriggered ?? 0} runs</span>
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
    el.logs.innerHTML = `<p class="empty">Debug logs unavailable: ${esc(countResult.error.message)}</p>`;
    return;
  }

  logCount = countResult.value.totalSize ?? 0;
  // SUM(LogLength) is not supported everywhere; the count alone is still useful.
  const bytes = sizeResult.ok ? sizeResult.value.records?.[0]?.total : null;
  const size = typeof bytes === "number" ? ` <span class="sub">· ${formatBytes(bytes)}</span>` : "";

  el.logs.innerHTML = `
    <div class="logline">
      <span class="grow"><b>${formatNumber(logCount)}</b> log${logCount === 1 ? "" : "s"}${size}</span>
      <button class="danger-btn" data-action="purge-logs" ${logCount ? "" : "disabled"}>Delete all</button>
    </div>
    <div class="log-progress" id="logProgress" ${purgeMessage ? "" : "hidden"}>${esc(purgeMessage)}</div>`;

  purgeArmed = false;
}

function purgeButton() {
  return el.logs.querySelector('[data-action="purge-logs"]');
}

function onPurgeClick() {
  const btn = purgeButton();
  if (!btn || btn.disabled) return;

  // Two-step confirm: this is irreversible and there is no undo in Salesforce.
  if (!purgeArmed) {
    purgeArmed = true;
    btn.classList.add("confirm");
    btn.textContent = `Delete ${formatNumber(logCount)}? Click again`;
    clearTimeout(purgeTimer);
    purgeTimer = setTimeout(() => {
      purgeArmed = false;
      btn.classList.remove("confirm");
      btn.textContent = "Delete all";
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
  btn.textContent = "Deleting…";
  progress.hidden = false;
  progress.textContent = "Starting…";

  try {
    const { deleted, failed } = await purgeApexLogs((done, bad) => {
      progress.textContent = `Deleted ${formatNumber(done)} of ${formatNumber(total)}` +
        (bad ? ` · ${bad} refused` : "");
    });
    purgeMessage = `Deleted ${formatNumber(deleted)} log${deleted === 1 ? "" : "s"}` +
      (failed ? `, ${formatNumber(failed)} could not be deleted` : "") + ".";
  } catch (err) {
    purgeMessage = `Failed: ${err.message}`;
  } finally {
    progress.textContent = purgeMessage;
    btn.disabled = false;
    btn.textContent = "Delete all";
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
    parts.push(progressBar("Components", d.NumberComponentsDeployed,
      d.NumberComponentsTotal, d.NumberComponentErrors));
  }
  if (d.NumberTestsTotal > 0) {
    parts.push(progressBar("Tests", d.NumberTestsCompleted,
      d.NumberTestsTotal, d.NumberTestErrors));
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

  parts.push(`<div class="card-actions">
    <button class="chip" data-deploy-setup="${esc(d.Id)}">Open in Setup</button>
    <button class="chip" data-copy="${esc(d.Id)}">Copy Id</button>
    <button class="chip" data-copy="sf project deploy report --job-id ${esc(d.Id)}">Copy sf command</button>
  </div>`);

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
    if (s.kind === "devconsole") return `<button class="sc" data-devconsole>${SC_ICONS.devconsole}${esc(s.label)}</button>`;
    if (s.kind === "apex") return `<button class="sc" data-apexrunner>${SC_ICONS.apex}${esc(s.label)}</button>`;
    if (!s.path) return "";
    return `<button class="sc" data-setup="${esc(s.path)}">${SC_ICONS.path}${esc(s.label)}</button>`;
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
    el.jumpHint.textContent = "Ids are 15 or 18 characters.";
    el.jumpHint.classList.add("bad");
    return;
  }

  el.jumpHint.classList.remove("bad");
  el.jumpHint.textContent = "Looking up…";

  try {
    const map = await keyPrefixMap();
    const name = map[raw.slice(0, 3)];
    if (!name) {
      el.jumpHint.textContent = `Unknown object prefix "${raw.slice(0, 3)}".`;
      el.jumpHint.classList.add("bad");
      return;
    }
    jumpTarget = { name, id: raw };
    el.jumpHint.textContent = `${name} — press Enter to open`;
  } catch (err) {
    el.jumpHint.textContent = err.message;
    el.jumpHint.classList.add("bad");
  }
}

function onJumpKey(ev) {
  if (ev.key !== "Enter" || !jumpTarget || !session) return;
  toHost({
    type: "navigate",
    url: `https://${session.lightningHost}/lightning/r/${jumpTarget.name}/${jumpTarget.id}/view`,
    newTab: ev.ctrlKey || ev.metaKey || ev.shiftKey,
  });
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

/** Short absolute stamp for future times, where "in 4h" is less useful than "14:00". */
function absoluteShort(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { day: "2-digit", month: "2-digit" })} ${time}`;
}

const formatNumber = n => Number(n || 0).toLocaleString();

function formatMb(mb) {
  const n = Number(mb) || 0;
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${formatNumber(Math.round(n))} MB`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
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

function flash(button, message) {
  const original = button.textContent;
  button.textContent = message;
  setTimeout(() => { button.textContent = original; }, 1200);
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

document.addEventListener("click", async ev => {
  const link = ev.target.closest("[data-href]");
  if (link) {
    toHost({ type: "navigate", url: link.dataset.href, newTab: true });
    return;
  }

  const copySource = ev.target.closest("[data-copy]");
  if (copySource) {
    const ok = await copyText(copySource.dataset.copy);
    flash(copySource, ok ? "Copied" : "Copy failed");
    return;
  }

  const deploySetup = ev.target.closest("[data-deploy-setup]");
  if (deploySetup && session) {
    const inner = `/changemgmt/monitorDeploymentsDetails.apexp?asyncId=${deploySetup.dataset.deploySetup}`;
    toHost({
      type: "navigate",
      url: `https://${session.lightningHost}/lightning/setup/DeployStatus/page?address=${encodeURIComponent(inner)}`,
      newTab: ev.ctrlKey || ev.metaKey || ev.shiftKey,
    });
    return;
  }

  const actionEl = ev.target.closest("[data-action]");
  const action = actionEl?.dataset.action;
  if (action === "reload-ext") {
    // The panel dies with the extension context, so say what happens next first.
    el.updateBanner.innerHTML =
      `<div class="banner-title">Reloading…</div>
       <div class="banner-body">Refresh this Salesforce tab to bring the panel back.</div>`;
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
    toHost({
      type: "navigate",
      url: `https://${session.lightningHost}${setupTarget.dataset.setup}`,
      newTab: ev.ctrlKey || ev.metaKey || ev.shiftKey,
    });
    return;
  }

  if (ev.target.closest("[data-devconsole]") && session) {
    toHost({
      type: "openWindow",
      url: `https://${session.apiHost}/_ui/common/apex/debug/ApexCSIPage`,
      name: "DeveloperConsole",
      features: "width=1280,height=800,resizable=yes,scrollbars=yes,toolbar=no,location=no",
    });
    return;
  }

  if (ev.target.closest("[data-apexrunner]")) {
    bg("openApexRunner", { host: pageHost }).catch(err => showBanner(esc(err.message)));
  }
});

el.refreshDeploy.addEventListener("click", () => refreshDeploys());
el.refreshJobs.addEventListener("click", () => refreshJobs());
el.refreshOrg.addEventListener("click", () => refreshOrg());
el.refreshAll.addEventListener("click", () => {
  el.refreshAll.classList.add("spin");
  Promise.all([refreshDeploys(), refreshJobs(), refreshOrg(), checkForUpdate({ force: true })])
    .finally(() => el.refreshAll.classList.remove("spin"));
});
el.close.addEventListener("click", () => toHost({ type: "close" }));
el.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
el.editShortcuts.addEventListener("click", () => chrome.runtime.openOptionsPage());
el.jumpInput.addEventListener("input", onJumpInput);
el.jumpInput.addEventListener("keydown", onJumpKey);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[SHORTCUTS_KEY]) renderShortcuts();
});

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

  el.orgName.title = `v${chrome.runtime.getManifest().version}`;
  renderShortcuts();
  checkForUpdate(); // fire and forget - never blocks the org data

  try {
    session = await bg("getSession", { host: pageHost });
  } catch (err) {
    el.orgHost.textContent = "not connected";
    el.deploy.innerHTML = "";
    el.limits.innerHTML = "";
    showBanner(esc(err.message));
    return;
  }

  client = new SalesforceClient(session.apiHost, session.sessionId);
  el.orgHost.textContent = session.apiHost;
  el.orgHost.title = `${session.apiHost} · org ${session.orgId}`;

  await Promise.all([refreshDeploys(), refreshJobs(), refreshOrg()]);
}

init();
