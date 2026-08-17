# Orgscope

A Chrome/Edge (Manifest V3) extension that adds a slide-out side panel to any Salesforce
org you are logged into — deployment status, Apex job KPIs, org limits, debug log
control and Setup shortcuts — plus an Anonymous Apex runner with a debug log viewer.

No build step, no dependencies. Load the folder as-is.

## Install

1. `git clone` this repo somewhere permanent — the browser loads the extension
   from that folder every launch, so don't put it in Downloads.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. **Load unpacked** → pick the cloned folder.
5. Open any Salesforce tab. A blue tab appears on the right edge — click it,
   or press **Alt+Shift+S**, or click the toolbar icon.

## Staying up to date

A developer-mode extension never updates itself, so the panel checks for you: on
open (at most once every 6 hours) it reads `manifest.json` from the repo's default
branch and compares versions. If yours is behind you get a banner with the new
version number, a link to the commits, and a **Reload extension** button.

`git pull` first, *then* hit Reload — the button calls `chrome.runtime.reload()`,
which re-reads the folder from disk, so you never have to visit
`chrome://extensions`. It does tear down the panel, so refresh the Salesforce tab
afterwards. Dismissing silences that specific version.

The check is an unauthenticated GET against `raw.githubusercontent.com`, which is why
the repo is public. Nothing is sent anywhere; it is a plain file read. Repo
coordinates live in [src/config.js](src/config.js); blank them to disable the check.

**When you publish a change, bump `version` in `manifest.json`** — that field is the
only thing the check compares. See [CLAUDE.md](CLAUDE.md) for the full rule.

## What's in the panel

### Deployment status

The currently running deploy (or the most recent one if nothing is running), with live
component and test progress bars, duration, who started it, and validation-vs-deploy.
Failed deploys expand into the actual component errors and test failures. Four earlier
deployments collapse below. Each card carries **Open in Setup**, **Copy Id** and
**Copy sf command** (`sf project deploy report --job-id …`).

### Apex jobs

Three counters, each clicking through to the matching Setup page:

| Tile | Query |
| --- | --- |
| Scheduled | `CronTrigger` where `CronJobDetail.JobType = '7'`, excluding deleted/complete |
| Running | `AsyncApexJob` with status `Processing` or `Preparing` |
| Flex queue | `AsyncApexJob` with status `Holding` |

`BatchApexWorker` rows are excluded everywhere — they are the individual chunks of a
running batch, so counting them would report one batch job as hundreds.

Below the tiles:

- **Running jobs**, listed with Apex class and method, job type, who started it, elapsed
  time, a batches-processed bar, error count, `ExtendedStatus`, and an estimated finish.
- **Failed in the last 24h**, collapsed.
- **Scheduled jobs**, collapsed by default (production carries dozens), with next and
  previous fire time, cron expression and run count. The summary badges how many are in
  `ERROR`, `PAUSED` or `BLOCKED` — a scheduled job that quietly died is exactly what
  this is for.

**About the finish estimate.** `AsyncApexJob` has no "started processing" timestamp —
`CreatedDate` is when the job was *queued*, so a naive `items / elapsed` rate is badly
pessimistic for anything that sat in the flex queue first. The panel keeps a throughput
sample per job id across refreshes: once it has watched a job for at least 10s and seen
the counter move, it uses the measured rate. Until then it falls back to the queue-time
average and labels it "(rough)". Hover the estimate to see which basis was used.

### Org limits

Daily API requests, daily async Apex executions, data and file storage, single and mass
email, hourly time-based workflow — each with a consumption bar that turns amber at 75%
and red at 90%. Org-wide Apex coverage sits underneath, red below the 75% deploy gate.

### Debug logs

Row count and total size, with a **Delete all** button behind a two-click confirm.
Clogged `ApexLog` storage silently stops new logs being written, which is the whole
reason this exists. Deletion is paged 200 at a time with live progress.

### Shortcuts

Fully configurable — see below. Ships with Object Manager, Developer Console, Anonymous
Apex and Deployment Status. Above them is a record-Id box: paste any 15- or 18-character
Id, and the key prefix is resolved against the org's global describe to open the record.

Ctrl/Cmd/Shift-click any Setup link to open it in a new tab.

## Language

English, Português (Brasil), Español and Русский, picked in Options. The default
follows your browser and falls back to English. The choice syncs across your
machines, and dates and numbers follow it too — not the browser locale.

Untranslated text falls back to English rather than showing a blank.

Adding a language is one file in `src/i18n/` plus two entries in its `index.js`.
Run `node tools/check-i18n.js` afterwards — it verifies key parity, plural
categories, that every referenced key exists and that nothing is still hard-coded.

## Options

Toolbar icon → **Options**, or the pencil in the panel's Shortcuts header.

Shortcuts are a list of label + Setup path, stored in `chrome.storage.sync` so they
follow you across machines. Add from a catalog of common Setup pages, or paste any path
you can reach in Setup. Two entries are built-in actions rather than paths: Developer
Console and Anonymous Apex. Changes save automatically.

## Anonymous Apex runner

Opens in its own tab. Write Apex, **Ctrl+Enter** to run.

The Tooling API's `executeAnonymous` does not return a debug log, so to show one the
runner does what the Developer Console does: ensures a `DebugLevel` named
`Orgscope` and a `TraceFlag` on your user exist (30 minutes, three presets — Debug,
Finest, Errors only), runs the code, then finds the `ApexLog` the run produced and
fetches its body.

Compile errors report line and column; unhandled exceptions report message and stack
trace. The log pane has a **USER_DEBUG only** filter, copy and download, and the last 20
snippets are kept in a history dropdown. Untick **Capture debug log** to skip the
TraceFlag work and just execute.

## How it talks to Salesforce

Same mechanism Salesforce Inspector uses. The service worker reads the `sid`
cookie for the current tab, takes its org id prefix, and finds the sibling `sid`
cookie issued on the org's `*.my.salesforce.com` domain — the Lightning session
id is not accepted by the API, that one is. The panel then calls the REST and
Tooling APIs from the extension origin with that session as a bearer token.

Nothing leaves the browser: no server, no telemetry, no stored credentials.

Notes:

- The API version is discovered at runtime from `/services/data/`, so the
  extension does not go stale when the org is upgraded.
- Three independent refresh cycles: **deployments** at 4s while one is running and 30s
  otherwise, **jobs** always at 30s, **org info** (limits, coverage, identity) only at
  boot and on demand. Deployments and jobs pause completely when the panel is closed or
  the tab is backgrounded.
- The whole jobs cycle — three counters, running detail, scheduled detail, failed jobs,
  log count, log size, limits — is a single `composite/batch` call. Nine reads, one API
  call.
- Each section header has its own ⟳ to refresh just that section; the one in the top bar
  refreshes everything. The footer shows the last update time per cycle.
- Requires the **API Enabled** permission on your user (any admin/developer
  profile has it).

## Panel behaviour

- Drag the panel's left edge to resize; width and open/closed state persist.
- Deployment failure details are fetched lazily and cached per deploy id, so
  polling a failed deploy does not re-download them.

## Known rough edges

- The deployment list comes from the Tooling API `DeployRequest` object. Field
  availability there varies between orgs and API versions, so the panel probes three
  progressively simpler queries and sticks with the first that works. Same idea for the
  `AsyncApexJob` relationship fields (`ApexClass.Name`, `CreatedBy.Name`), which
  field-level security can block — it drops to a flat projection and the class name
  shows as unavailable.
- Failure detail comes from
  `/services/data/vXX.X/metadata/deployRequest/{id}?includeDetails=true`. If your org
  rejects that endpoint the card still renders, just without the expandable error list.
- [TODO.md](TODO.md) lists the calls that have not been exercised against a live org
  yet. They all degrade to a visible error rather than breaking the panel — if you see
  one, the message is the raw Salesforce error and worth pasting back.
- Only tested against the domain patterns in `manifest.json`. If you use a
  custom `my.site.com` or an unusual sandbox domain, add it to both
  `host_permissions` and `content_scripts.matches`.

## Layout

```
manifest.json
src/config.js       repo coordinates for the update check
src/shortcuts.js    shortcut defaults, catalog and storage helpers
src/background.js   session/cookie resolution, update check, tab + shortcut handling
src/content.js      shadow-DOM launcher tab, slide-out panel host, resize
src/panel.*         the side panel UI and its Salesforce API calls
src/options.*       shortcut editor
src/apex.*          Anonymous Apex runner and log viewer
src/page.css        shared styling for the full-tab pages
src/i18n/           the i18n runtime and one module per language
tools/check-i18n.js key parity, plural and coverage check
icons/
```
