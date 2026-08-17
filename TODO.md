# Roadmap

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

- [ ] `limits` as a `composite/batch` subrequest — if the org rejects it, move it to
      its own fetch in the org cycle.
- [ ] `SELECT SUM(LogLength) FROM ApexLog` — aggregate support on `ApexLog` is not
      guaranteed. The count renders regardless; only the size would go missing.
- [ ] `composite/sobjects` DELETE for `ApexLog`. There is a one-by-one fallback, but it
      is 200× the API calls, so worth confirming the fast path works.
- [ ] The deploy Setup deep link
      (`/lightning/setup/DeployStatus/page?address=…monitorDeploymentsDetails.apexp…`).
- [ ] `TraceFlag`/`DebugLevel` creation in an org that already has an active
      developer-log trace flag from the Developer Console.
- [ ] Setup paths in the shortcut catalog — a few are from memory and may 404. They are
      editable in the options page, so a wrong one is a quick fix.

## Ideas not taken

- Deploy-finished desktop notification — dropped, not wanted.
- Abort job / reorder flex queue — needs anonymous Apex and turns a read-only panel
  into one that can kill production jobs. Revisit if it becomes a real need.
