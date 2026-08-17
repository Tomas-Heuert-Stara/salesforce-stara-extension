/**
 * Shortcut list: defaults, the pick-from catalog used by the options page, and
 * the storage helpers both the panel and the options page share.
 *
 * A shortcut is either a Setup path (`{ label, path }`) or one of the built-in
 * actions (`{ label, kind: "devconsole" | "apex" }`), which need a URL the panel
 * assembles at runtime.
 */

const STORAGE_KEY = "shortcuts";

export const DEFAULT_SHORTCUTS = [
  { label: "Object Manager", path: "/lightning/setup/ObjectManager/home" },
  { label: "Developer Console", kind: "devconsole" },
  { label: "Anonymous Apex", kind: "apex" },
  { label: "Deployment Status", path: "/lightning/setup/DeployStatus/home" },
];

/**
 * Offered in the options page picker. Paths are editable after adding, so a
 * wrong one here is a two-second fix rather than a bug report.
 */
export const SHORTCUT_CATALOG = [
  { label: "Object Manager", path: "/lightning/setup/ObjectManager/home" },
  { label: "Apex Classes", path: "/lightning/setup/ApexClasses/home" },
  { label: "Apex Triggers", path: "/lightning/setup/ApexTriggers/home" },
  { label: "Apex Jobs", path: "/lightning/setup/AsyncApexJobs/home" },
  { label: "Apex Flex Queue", path: "/lightning/setup/ApexFlexQueue/home" },
  { label: "Scheduled Jobs", path: "/lightning/setup/ScheduledJobs/home" },
  { label: "Debug Logs", path: "/lightning/setup/ApexDebugLogs/home" },
  { label: "Deployment Status", path: "/lightning/setup/DeployStatus/home" },
  { label: "Flows", path: "/lightning/setup/Flows/home" },
  { label: "Users", path: "/lightning/setup/ManageUsers/home" },
  { label: "Profiles", path: "/lightning/setup/EnhancedProfiles/home" },
  { label: "Permission Sets", path: "/lightning/setup/PermSets/home" },
  { label: "Custom Settings", path: "/lightning/setup/CustomSettings/home" },
  { label: "Custom Metadata Types", path: "/lightning/setup/CustomMetadata/home" },
  { label: "Named Credentials", path: "/lightning/setup/NamedCredential/home" },
  { label: "Remote Site Settings", path: "/lightning/setup/SecurityRemoteProxy/home" },
  { label: "Email Deliverability", path: "/lightning/setup/OrgEmailSettings/home" },
  { label: "Company Information", path: "/lightning/setup/CompanyProfileInfo/home" },
  { label: "Installed Packages", path: "/lightning/setup/ImportedPackage/home" },
  { label: "Static Resources", path: "/lightning/setup/StaticResources/home" },
  { label: "Platform Events", path: "/lightning/setup/EventObjects/home" },
  { label: "Queues", path: "/lightning/setup/Queues/home" },
  { label: "Setup Home", path: "/lightning/setup/SetupOneHome/home" },
  { label: "Developer Console", kind: "devconsole" },
  { label: "Anonymous Apex", kind: "apex" },
];

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
