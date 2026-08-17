/**
 * Service worker.
 *
 * Its main job is turning "the tab is on some Salesforce domain" into
 * "here is an API-enabled host + session id", which requires the cookies
 * permission and therefore cannot happen in the panel itself. It also owns the
 * "is this checkout out of date?" check against the public repo.
 */

import { REPO } from "./config.js";

// help.salesforce.com hands out a sid for the same org id, but it is not an
// API host. Same story for the trailhead/tableau satellites.
const NON_API_DOMAINS = new Set([
  "help.salesforce.com",
  "trailhead.salesforce.com",
  "trailblazer.me",
  "developer.salesforce.com",
  "partners.salesforce.com",
  "appexchange.salesforce.com",
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // keep the channel open for the async response
});

async function handle(msg, sender) {
  switch (msg?.type) {
    case "getSession":
      return getSession(msg.host, sender?.tab?.cookieStoreId);
    case "checkUpdate":
      return checkUpdate({ force: !!msg.force });
    case "reloadExtension":
      // Re-reads the folder from disk, which is what a developer-mode install needs
      // after a git pull. Tears down every content script, hence the caller warning.
      setTimeout(() => chrome.runtime.reload(), 100);
      return { reloading: true };
    default:
      throw new Error(`Unknown message type: ${msg?.type}`);
  }
}

/**
 * Resolve the API session for the org the given page host belongs to.
 *
 * The sid cookie on a Lightning host is not accepted by the REST API, so we
 * take its org id prefix and look for the sibling cookie issued on the
 * *.my.salesforce.com domain, which is.
 */
async function getSession(pageHost, storeId) {
  if (!pageHost) throw new Error("No host supplied.");
  const scope = storeId ? { storeId } : {};

  const pageCookie = await chrome.cookies.get({
    url: `https://${pageHost}`,
    name: "sid",
    ...scope,
  });

  if (!pageCookie || !pageCookie.value.includes("!")) {
    throw new Error("Not logged in to Salesforce on this domain.");
  }

  const orgId = pageCookie.value.split("!")[0];
  const all = await chrome.cookies.getAll({ name: "sid", secure: true, ...scope });

  const candidates = all
    .map(c => ({ ...c, domain: c.domain.replace(/^\./, "") }))
    .filter(c => c.value.startsWith(`${orgId}!`) && !NON_API_DOMAINS.has(c.domain));

  const pick =
    candidates.find(c => c.domain.endsWith(".my.salesforce.com")) ||
    candidates.find(c => c.domain.endsWith(".salesforce.com")) ||
    candidates.find(c => c.domain === pageHost) ||
    candidates[0];

  if (!pick) {
    throw new Error(
      "Could not find an API-enabled session. Open the org's *.my.salesforce.com " +
      "domain once (Setup loads it), then reopen this panel."
    );
  }

  return {
    apiHost: pick.domain,
    sessionId: pick.value,
    orgId,
    // Setup/Lightning links go here; the API host is not always browsable.
    lightningHost: toLightningHost(pageHost, pick.domain),
  };
}

function toLightningHost(pageHost, apiHost) {
  if (pageHost.endsWith(".lightning.force.com")) return pageHost;
  if (apiHost.endsWith(".my.salesforce.com")) {
    return apiHost.replace(/\.my\.salesforce\.com$/, ".lightning.force.com");
  }
  return pageHost;
}

// ---------------------------------------------------------------------------
// update check
// ---------------------------------------------------------------------------

const UPDATE_CACHE_KEY = "updateCheck";
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;

async function checkUpdate({ force = false } = {}) {
  const current = chrome.runtime.getManifest().version;
  if (!REPO.owner || !REPO.repo) return { configured: false, current };

  const repoUrl = `https://github.com/${REPO.owner}/${REPO.repo}`;
  const cached = (await chrome.storage.local.get(UPDATE_CACHE_KEY))[UPDATE_CACHE_KEY];

  if (!force && cached && Date.now() - cached.checkedAt < UPDATE_TTL_MS) {
    return decorate(cached.latest, cached.checkedAt);
  }

  // raw.githubusercontent serves the default branch's file with no auth for a
  // public repo. Its CDN caches for a few minutes, which is fine for a version nag.
  const res = await fetch(
    `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/manifest.json`,
    { cache: "no-store", credentials: "omit" }
  );
  if (!res.ok) throw new Error(`Could not reach GitHub (HTTP ${res.status}).`);

  const latest = String(JSON.parse(await res.text()).version || "");
  const checkedAt = Date.now();
  await chrome.storage.local.set({ [UPDATE_CACHE_KEY]: { latest, checkedAt } });
  return decorate(latest, checkedAt);

  function decorate(latest, checkedAt) {
    return {
      configured: true,
      current,
      latest,
      checkedAt,
      repoUrl,
      commitsUrl: `${repoUrl}/commits/${REPO.branch}`,
      outdated: compareVersions(latest, current) > 0,
    };
  }
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// Toolbar button and keyboard shortcut both just ask the content script to toggle.
chrome.action.onClicked.addListener(tab => togglePanel(tab?.id));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-panel") togglePanel(tab?.id);
});

function togglePanel(tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "togglePanel" }).catch(() => {
    // No content script on this tab (not a Salesforce page) - nothing to do.
  });
}
