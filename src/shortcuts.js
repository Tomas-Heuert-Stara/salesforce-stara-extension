/**
 * Shortcut list: defaults, the pick-from catalog used by the options page, and
 * the storage helpers both the panel and the options page share.
 *
 * A shortcut is either a Setup path (`{ path }`) or a built-in action
 * (`{ kind: "devconsole" | "apex" }`), which needs a URL assembled at runtime.
 *
 * Labels come in two flavours, and the difference matters:
 *   { key: "sc.flows" }   - ours, translated on render
 *   { label: "Flows" }    - the user typed it, shown verbatim, never translated
 * Adding from the catalog stores the key; editing the text in the options page
 * converts the entry to a literal label. Lists saved before i18n existed only
 * have labels, so they keep working untouched.
 */

import { t } from "./i18n/index.js";

const STORAGE_KEY = "shortcuts";

export const DEFAULT_SHORTCUTS = [
  { key: "sc.objectManager", path: "/lightning/setup/ObjectManager/home" },
  { key: "sc.devConsole", kind: "devconsole" },
  { key: "sc.anonymousApex", kind: "apex" },
  { key: "sc.deployStatus", path: "/lightning/setup/DeployStatus/home" },
];

/** Offered in the options page picker. Paths stay editable after adding. */
export const SHORTCUT_CATALOG = [
  { key: "sc.objectManager", path: "/lightning/setup/ObjectManager/home" },
  { key: "sc.apexClasses", path: "/lightning/setup/ApexClasses/home" },
  { key: "sc.apexTriggers", path: "/lightning/setup/ApexTriggers/home" },
  { key: "sc.apexJobs", path: "/lightning/setup/AsyncApexJobs/home" },
  { key: "sc.flexQueue", path: "/lightning/setup/ApexFlexQueue/home" },
  { key: "sc.scheduledJobs", path: "/lightning/setup/ScheduledJobs/home" },
  { key: "sc.debugLogs", path: "/lightning/setup/ApexDebugLogs/home" },
  { key: "sc.deployStatus", path: "/lightning/setup/DeployStatus/home" },
  { key: "sc.flows", path: "/lightning/setup/Flows/home" },
  { key: "sc.users", path: "/lightning/setup/ManageUsers/home" },
  { key: "sc.profiles", path: "/lightning/setup/EnhancedProfiles/home" },
  { key: "sc.permSets", path: "/lightning/setup/PermSets/home" },
  { key: "sc.customSettings", path: "/lightning/setup/CustomSettings/home" },
  { key: "sc.customMetadata", path: "/lightning/setup/CustomMetadata/home" },
  { key: "sc.namedCredentials", path: "/lightning/setup/NamedCredential/home" },
  { key: "sc.remoteSites", path: "/lightning/setup/SecurityRemoteProxy/home" },
  { key: "sc.emailDeliverability", path: "/lightning/setup/OrgEmailSettings/home" },
  { key: "sc.companyInfo", path: "/lightning/setup/CompanyProfileInfo/home" },
  { key: "sc.installedPackages", path: "/lightning/setup/ImportedPackage/home" },
  { key: "sc.staticResources", path: "/lightning/setup/StaticResources/home" },
  { key: "sc.platformEvents", path: "/lightning/setup/EventObjects/home" },
  { key: "sc.queues", path: "/lightning/setup/Queues/home" },
  { key: "sc.setupHome", path: "/lightning/setup/SetupOneHome/home" },
  { key: "sc.devConsole", kind: "devconsole" },
  { key: "sc.anonymousApex", kind: "apex" },
];

/** Display text for one entry: user label wins, otherwise translate the key. */
export function shortcutLabel(entry) {
  if (entry.label != null && entry.label !== "") return entry.label;
  if (entry.key) return t(entry.key);
  return "";
}

export async function loadShortcuts() {
  const stored = (await chrome.storage.sync.get(STORAGE_KEY))[STORAGE_KEY];
  return Array.isArray(stored) && stored.length ? stored : DEFAULT_SHORTCUTS;
}

export async function saveShortcuts(list) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: list });
}

export async function resetShortcuts() {
  await chrome.storage.sync.remove(STORAGE_KEY);
}

export const SHORTCUTS_KEY = STORAGE_KEY;
