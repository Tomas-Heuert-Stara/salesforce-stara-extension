# Working on this repo

MV3 Chrome/Edge extension, no build step, no dependencies. It is installed
unpacked from a clone of <https://github.com/Tomas-Heuert-Stara/salesforce-stara-extension>,
which drives everything below.

## Versioning — read this before finishing any change

`manifest.json` → `version` is the **only** signal users get that something
changed. [src/background.js](src/background.js) reads that field from `main` via
`raw.githubusercontent.com` and shows an update banner when a user's local copy is
behind. Commits alone trigger nothing.

**So: any change that a user would notice must bump the version in the same
commit.** Forgetting this is silent — the code works, nobody is ever told to pull.

| Bump | When |
| --- | --- |
| **Patch** (`0.1.0` → `0.1.1`) | Bug fix, styling, wording, refactor with no visible change. |
| **Minor** (`0.1.0` → `0.2.0`) | New feature: a section, KPI, shortcut, new data on an existing card. |
| **Major** (`0.x` → `1.0`) | Rework that changes how the extension is installed or configured, or that needs the user to do something by hand. |

Bump **minor at least** when touching `permissions` or `host_permissions`. New
permissions only take effect on extension reload, and Chrome may warn the user —
worth an explicit release rather than sneaking in on a patch.

Constraints on the field: one to four dot-separated integers, each 0–65535, no
leading zeros. `0.2.0` is fine, `0.02.0` is not.

Purely internal edits — this file, `README.md`, comments — do not need a bump.

### Release checklist

1. Bump `version` in `manifest.json`.
2. Write a commit message that reads well on its own. The banner's "What changed"
   button links to the commit list on `main`; those subject lines *are* the
   changelog.
3. Push to `main`. `raw.githubusercontent.com` caches for a few minutes, and the
   panel caches its check result for 6 hours, so allow some lag before the banner
   appears elsewhere. The top-bar ⟳ forces an immediate check.

## Architecture notes worth not re-deriving

**Session.** [src/background.js](src/background.js) reads the `sid` cookie for the
current tab, takes its org id prefix, then finds the sibling `sid` cookie on the
org's `*.my.salesforce.com` domain. This indirection is required: a Lightning
session id is rejected by the API, that one is not. Needs the `cookies` permission,
hence it lives in the service worker.

**Why the panel is an iframe.** [src/panel.html](src/panel.html) is an extension
page embedded by [src/content.js](src/content.js). Extension pages keep
cross-origin fetch privileges from `host_permissions`; MV3 content scripts do not.
Keeping the API calls there also avoids Salesforce's page CSP entirely. The two
sides talk over `postMessage` (`stara-sfx-panel` / `stara-sfx-host`), since the
iframe cannot touch `top.location` itself.

**Polling.** Three cycles in [src/panel.js](src/panel.js): deploys (4s while one is
active, 30s otherwise), jobs (always 30s), and org info — limits, coverage, org
identity — which has no timer at all because it barely changes. Deploys and jobs
stop when the panel is closed or the tab is hidden. Keep it that way; a 4s poll
that never pauses would chew through the org's daily API limit.

**API budget.** The entire jobs cycle is one `composite/batch` call with nine
subrequests. Add new counters as subrequests there rather than as new fetches, and
mind the 25-subrequest ceiling. Anything slow-moving belongs in the org cycle.

**Other surfaces.** [src/options.html](src/options.html) (shortcut editor, registered
via `options_ui`) and [src/apex.html](src/apex.html) (Anonymous Apex runner) are
full-tab extension pages, opened by `chrome.tabs.create` from the service worker.
They resolve their own session through the same `getSession` message, so they take a
`?host=` query param naming the Salesforce page host.

**Log capture.** `executeAnonymous` never returns a debug log. The runner creates or
extends a `DebugLevel` + `TraceFlag` on the current user, snapshots the newest
`ApexLog` id, executes, then polls for a newer one. Salesforce refuses a second
overlapping trace flag for the same entity, so the existing one is PATCHed rather
than duplicated.

**Destructive actions** get a two-click confirm and a visible result that survives the
refresh that follows. The debug-log purge is the only one so far — keep that bar for
anything new.

**Query ladders.** `DeployRequest` field availability and the `AsyncApexJob`
relationship fields vary by org and API version, so both have fallback query lists
that get probed in order, with the winning index remembered. When adding fields,
add them to the richest variant only and let the ladder degrade.

**API version** is discovered at runtime from `/services/data/`. Never hardcode
one.

## Conventions

- Vanilla JS, no framework, no npm. Keep it that way; the install story is
  "clone and load unpacked".
- All Salesforce-derived strings go through `esc()` before reaching `innerHTML`.
- The panel is styled with CSS custom properties and supports
  `prefers-color-scheme: dark`. Add colours as tokens in `:root`, and define them
  in both palettes.
