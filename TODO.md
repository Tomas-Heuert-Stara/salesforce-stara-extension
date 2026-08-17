# Roadmap

## v0.2.1 — fixes from first live run

- [x] Options and Edit-shortcuts buttons did nothing — `chrome.runtime.openOptionsPage()`
      is unreliable from an embedded extension frame; routed through the service worker.
- [x] Limits over 100% were clamped, hiding the overage. Now shows the real percentage,
      how much over, and a striped red row distinct from merely "high".
- [x] Everything opens in a new tab now, Developer Console included. New tabs go through
      `chrome.tabs.create` in the service worker, because `window.open` from the host
      page is not a user gesture and popup blockers were eating it.
- [x] Limits moved out of the jobs batch into their own fetch on a 60s timer — the
      section's own ⟳ was previously not refreshing them at all.
- [x] Org limits section is collapsible, open by default.
- [x] Earlier deployments got icon buttons for open-in-Setup / copy Id / copy sf command.
- [x] Collapsibles keep their open/closed state across polls.
- [x] Percentages on every progress bar — deployment components, deployment tests, and
      running-job batches.
- [x] Remaining-time estimate for in-progress deployments, projected from whichever
      phase is currently moving (tests if running, else components).
- [x] Options icon was a sun, not a gear. Now sliders.
- [x] A stale service worker after `git pull` now reports "Extension needs a reload"
      with a one-click fix instead of `Unknown message type: …`.

## v0.2.0 — done

- [x] **Org limits row** — `GET /services/data/vXX/limits`: Daily API Requests, Daily
      Async Apex Executions, Data Storage, File Storage, Single Email, Mass Email,
      Hourly Time Based Workflow. Bar per row, amber at 75%, red at 90%.
- [x] **Recently failed Apex jobs** — `Status = 'Failed'` in the last 24h, collapsed.
- [x] **Scheduled jobs detail** — next/previous fire time, cron expression, run count.
      Collapsible, closed by default, with a badge counting `ERROR`/`PAUSED`/`BLOCKED`.
- [x] **Sandbox badge fixed** — reads `Organization.IsSandbox`; header now shows the
      real org name.
- [x] **Apex code coverage** — org-wide percent from `ApexOrgWideCoverage`, red under 75%.
- [x] **Debug log volume** — `ApexLog` count and total `LogLength`.
- [x] **Purge debug logs** — paged delete with progress and a two-click confirm.
- [x] **Deploy card extras** — open in Setup, copy Id, copy `sf project deploy report`.
- [x] **Record Id → jump** — key-prefix lookup against the cached global describe.
- [x] **Options page** — shortcut list in `chrome.storage.sync`, catalog + custom entries.
- [x] **Anonymous Apex runner + debug log viewer** — own tab, `DebugLevel` + `TraceFlag`
      setup, USER_DEBUG filter, history, copy/download.
- [x] Bump to `0.2.0`.

## Needs verification against a real org

These are written defensively (they degrade to an error message rather than breaking
the panel) but none have been run against a live org yet:

- [X] `limits` as a `composite/batch` subrequest — if the org rejects it, move it to
      its own fetch in the org cycle.
- [X] `SELECT SUM(LogLength) FROM ApexLog` — aggregate support on `ApexLog` is not
      guaranteed. The count renders regardless; only the size would go missing.
- [X] `composite/sobjects` DELETE for `ApexLog`. There is a one-by-one fallback, but it
      is 200× the API calls, so worth confirming the fast path works.
- [X] The deploy Setup deep link
      (`/lightning/setup/DeployStatus/page?address=…monitorDeploymentsDetails.apexp…`).
- [X] `TraceFlag`/`DebugLevel` creation in an org that already has an active
      developer-log trace flag from the Developer Console.
- [X] Setup paths in the shortcut catalog — a few are from memory and may 404. They are
      editable in the options page, so a wrong one is a quick fix.

## Ideas not taken

- Deploy-finished desktop notification — dropped, not wanted.
- Abort job / reorder flex queue — needs anonymous Apex and turns a read-only panel
  into one that can kill production jobs. Revisit if it becomes a real need.
