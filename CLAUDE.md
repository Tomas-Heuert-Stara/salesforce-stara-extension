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
sides talk over `postMessage` (`orgscope-panel` / `orgscope-host`), since the
iframe cannot touch `top.location` itself.

**Polling.** Four cycles in [src/panel.js](src/panel.js): deploys (4s while one is
active, 30s otherwise), jobs (30s), limits (60s), and org meta — identity and
coverage — which has no timer because it barely changes. All timed cycles stop when
the panel is closed or the tab is hidden. Keep it that way; a 4s poll that never
pauses would chew through the org's daily API limit.

**A section's ⟳ must refresh what that section shows.** Limits originally rode along
in the jobs batch while the Org limits header called a different function, so its
refresh button did nothing visible. If you add a section, give it a cycle or wire its
button to the cycle that actually owns its data.

**API budget.** The jobs cycle is one `composite/batch` call with eight subrequests.
Add new counters as subrequests there rather than as new fetches, and mind the
25-subrequest ceiling.

**Opening tabs.** Always `bg("openTab", { url })`, never `window.open` from the
content script. The panel is an iframe, so a click in it is not a user gesture in the
host page and popup blockers silently drop the window. Everything in the panel opens
in a new tab by design — the point of a side panel is not losing your place.

**Re-rendering eats `<details>` state.** Every collapsible built inside a polled
render must carry `detailsAttr(key, defaultOpen)`; a capture-phase `toggle` listener
records the state (the event does not bubble). Forgetting it means the section slams
shut under the user every 30 seconds.

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

## Internationalisation

Chrome's own i18n (`_locales` + `chrome.i18n.getMessage`) resolves against the
*browser's* UI language with no runtime override, so a user-chosen language needs
the hand-rolled runtime in [src/i18n/index.js](src/i18n/index.js). Dictionaries are
plain ES modules; English is always loaded as the fallback.

**Any user-visible string goes through `t()`.** The workflow is: add the key to
`en.js` first, translate it in the other locales, then `node tools/check-i18n.js`.
That script is the safety net for the one thing that actually goes wrong here —
coverage. Strings on error paths only surface when something breaks, so a missed
one can sit there for months. It verifies key parity, plural categories, that every
referenced key exists, that no key is dead, and that no sentence-shaped literal is
still hard-coded.

Things worth not relearning:

- **Plural entries are objects keyed by CLDR category**, selected via
  `Intl.PluralRules`. Do not assume one/other: Spanish and Portuguese need `many`
  (exact millions) and Russian needs `one/few/many`. The check script asks Intl for
  each locale's real category list rather than trusting a guess.
- **Relative time uses `Intl.RelativeTimeFormat`**, so "5m ago" needs no dictionary
  entries in any language. Don't reintroduce hand-written ones.
- **`t()` does not escape.** Dictionary strings are ours and trusted; interpolated
  params often are not. Escape params at the call site when the result goes into
  `innerHTML`, and don't when it goes into `textContent`.
- **Dates and numbers follow the chosen language**, not the browser — use `fmt.*`
  from the i18n module, never `toLocaleString()` directly.
- **Shortcut labels are half data.** `{ key }` is ours and gets translated;
  `{ label }` was typed by the user and never is. Editing a catalog label in the
  options page deliberately drops the key.
- Deliberately untranslated: the extension name, the `DebugLevel` record name in
  the org, and two internal diagnostics kept in English so they stay searchable in
  bug reports. They are whitelisted in the check script.

Adding a language is one file plus two entries in `LOCALES` and `LOADERS`.

## Conventions

- Vanilla JS, no framework, no npm. Keep it that way; the install story is
  "clone and load unpacked".
- All Salesforce-derived strings go through `esc()` before reaching `innerHTML`.
- The panel is styled with CSS custom properties and supports
  `prefers-color-scheme: dark`. Add colours as tokens in `:root`, and define them
  in both palettes.
