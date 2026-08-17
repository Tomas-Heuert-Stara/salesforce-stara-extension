# Stara SF Toolbox

A Chrome/Edge (Manifest V3) extension that adds a slide-out side panel to any Salesforce
org you are logged into — deployment status, Apex job KPIs and Setup shortcuts.

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

**Setup, once:** fill in `src/config.js` with the repo coordinates.

```js
export const REPO = {
  owner: "your-github-user-or-org",
  repo: "salesforce-stara-extension",
  branch: "main",
};
```

Leave `owner` or `repo` empty and the check is disabled — no banner, no requests.
The check only ever does an unauthenticated GET against
`raw.githubusercontent.com`, so **the repo has to be public**. Nothing is sent
anywhere; it is a plain file read.

**When you publish a change, bump `version` in `manifest.json`.** That field is the
only thing the check compares — pushing commits without bumping it means nobody
gets told.

## What it shows

**Deployment status** — the currently running deploy (or the most recent one if
nothing is running), with live component and test progress bars, duration, who
started it, and validation-vs-deploy. Failed deploys expand into the actual
component errors and test failures. Four earlier deployments are listed below it.

**Apex jobs** — three counters, each clickable straight to the matching Setup page:

| Tile | Query |
| --- | --- |
| Scheduled | `CronTrigger` where `CronJobDetail.JobType = '7'` (Scheduled Apex), excluding deleted/complete |
| Running | `AsyncApexJob` with status `Processing` or `Preparing` |
| Flex queue | `AsyncApexJob` with status `Holding` |

`BatchApexWorker` rows are excluded everywhere. They are the individual chunks of a
running batch, so counting them would report one batch job as hundreds.

**Running job detail** — whenever the Running count is above zero, each job is listed
underneath with its Apex class and method, job type, who started it, elapsed time,
a batches-processed bar, error count, `ExtendedStatus`, and an estimated finish time.

The estimate deserves a note. `AsyncApexJob` has no "started processing" timestamp —
`CreatedDate` is when the job was *queued*, so a naive `items / elapsed` rate is badly
pessimistic for anything that sat in the flex queue first. So the panel keeps a
throughput sample per job id across refreshes: once it has watched a job for at least
10s and seen the counter move, it uses the measured rate. Until then it falls back to
the queue-time average and labels the result "(rough)". Hovering the estimate says
which basis was used.

**Shortcuts** — Object Manager, Developer Console (opens in its own window),
Deployment Status. Ctrl/Cmd/Shift-click any Setup link to open it in a new tab.

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
- Deployments and Apex jobs poll on **independent timers**: deployments at 4s while
  one is running and 30s otherwise, jobs always at 30s. Both pause completely when
  the panel is closed or the tab is in the background.
- The three counters plus the running-job detail go out as a single `composite/batch`
  call, so a jobs refresh costs one API call regardless of how much it shows.
- Each section header has its own ⟳ button to refresh just that section; the one in
  the top bar refreshes both. The footer shows the last update time for each.
- Requires the **API Enabled** permission on your user (any admin/developer
  profile has it).

## Panel behaviour

- Drag the panel's left edge to resize; width and open/closed state persist.
- Deployment failure details are fetched lazily and cached per deploy id, so
  polling a failed deploy does not re-download them.

## Known rough edges

- The deployment list comes from the Tooling API `DeployRequest` object. Field
  availability there varies a bit between orgs and API versions, so the panel
  probes three progressively simpler queries and sticks with the first one that
  works. If all three fail you get the raw Salesforce error in the panel —
  paste it back and the query can be adjusted.
- Failure detail comes from `/services/data/vXX.X/metadata/deployRequest/{id}?includeDetails=true`.
  If your org rejects that endpoint the card still renders, just without the
  expandable error list.
- The running-job list asks for `ApexClass.Name` and `CreatedBy.Name`. If field-level
  security on those blocks the relationship query, it drops to a flat projection and
  the class name shows as unavailable.
- Only tested against the domain patterns in `manifest.json`. If you use a
  custom `my.site.com` or an unusual sandbox domain, add it to both
  `host_permissions` and `content_scripts.matches`.

## Layout

```
manifest.json
src/config.js       repo coordinates for the update check
src/background.js   session/cookie resolution, update check, toolbar + shortcut
src/content.js      shadow-DOM launcher tab, slide-out panel host, resize
src/panel.html/.css/.js   the panel UI and all Salesforce API calls
icons/
```
