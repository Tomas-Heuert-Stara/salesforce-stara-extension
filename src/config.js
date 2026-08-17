/**
 * Update-check target.
 *
 * The extension compares its own manifest version against the one on the
 * repo's default branch and nags in the panel when the local copy is behind.
 * Fill in owner/repo once, commit it, and every clone gets the check.
 *
 * Leave `owner` or `repo` empty to disable the check entirely.
 */
export const REPO = {
  owner: "Tomas-Heuert-Stara",
  repo: "salesforce-stara-extension",
  branch: "main",
};
