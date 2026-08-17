#!/usr/bin/env node
/**
 * i18n consistency check.  Run: node tools/check-i18n.js
 *
 * The risk with a hand-rolled i18n sweep is not difficulty, it is coverage:
 * strings on error paths only surface when something breaks, so a miss can sit
 * there for months. This verifies what can be verified statically.
 *
 *   1. every locale has exactly the keys en.js has
 *   2. plural entries are plural in every locale, with all the categories that
 *      locale's CLDR rules can select (Russian needs one/few/many)
 *   3. every t("…") and data-i18n="…" in the source resolves to a real key
 *   4. no dictionary key is dead
 *   5. sentence-shaped literals still hard-coded in the page scripts
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = p => fs.readFileSync(path.join(root, p), "utf8");

const LOCALE_DIR = "src/i18n";
const SCRIPTS = ["src/panel.js", "src/options.js", "src/apex.js", "src/shortcuts.js", "src/i18n/index.js"];
const PAGES = ["src/panel.html", "src/options.html", "src/apex.html"];
// Keys assembled at runtime from Salesforce values, so no literal appears in source.
const DYNAMIC_PREFIXES = /^(status|jobType|cron|limits|sc)\./;

let failed = false;
const fail = msg => { console.error(`  ✗ ${msg}`); failed = true; };
const pass = msg => console.log(`  ✓ ${msg}`);

function loadDictionary(code) {
  const body = src(`${LOCALE_DIR}/${code}.js`).replace(/^[\s\S]*?export default /, "");
  // eslint-disable-next-line no-eval
  return eval(`(${body.replace(/;\s*$/, "")})`);
}

const locales = fs.readdirSync(path.join(root, LOCALE_DIR))
  .filter(f => f.endsWith(".js") && f !== "index.js")
  .map(f => f.replace(/\.js$/, ""));

const en = loadDictionary("en");
const enKeys = Object.keys(en);

console.log(`\nen.js — ${enKeys.length} keys, locales: ${locales.join(", ")}\n`);

// 1 + 2 ----------------------------------------------------------------------
console.log("key parity");
for (const code of locales.filter(c => c !== "en")) {
  const dict = loadDictionary(code);
  const missing = enKeys.filter(k => !(k in dict));
  const extra = Object.keys(dict).filter(k => !(k in en));
  const shape = enKeys.filter(k => k in dict && (typeof en[k] === "object") !== (typeof dict[k] === "object"));

  if (missing.length) fail(`${code}: missing ${missing.length} — ${missing.slice(0, 6).join(", ")}`);
  if (extra.length) fail(`${code}: ${extra.length} keys not in en — ${extra.slice(0, 6).join(", ")}`);
  if (shape.length) fail(`${code}: plural shape differs from en — ${shape.join(", ")}`);

  // Ask Intl which categories this language can actually produce. Spanish and
  // Portuguese gained "many" (exact millions) in newer CLDR, so this is not the
  // English one/other split even for languages that look like it.
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  let pluralsOk = true;
  for (const [key, value] of Object.entries(dict)) {
    if (!value || typeof value !== "object") continue;
    const absent = categories.filter(c => !(c in value));
    if (absent.length) {
      fail(`${code}: ${key} missing plural ${absent.join("/")}`);
      pluralsOk = false;
    }
  }

  if (!missing.length && !extra.length && !shape.length && pluralsOk) {
    pass(`${code} matches en (${categories.join("/")})`);
  }
}

// 3 + 4 ----------------------------------------------------------------------
console.log("\nkey usage");
const used = new Set();
for (const file of SCRIPTS) {
  for (const m of src(file).matchAll(/\bt\("([\w.]+)"/g)) used.add(m[1]);
}
for (const file of PAGES) {
  for (const m of src(file).matchAll(/data-i18n(?:-title|-placeholder)?="([\w.]+)"/g)) used.add(m[1]);
}

const unknown = [...used].filter(k => !(k in en));
if (unknown.length) fail(`referenced but undefined: ${unknown.join(", ")}`);
else pass(`${used.size} referenced keys all defined`);

const unused = enKeys.filter(k => !used.has(k) && !DYNAMIC_PREFIXES.test(k));
if (unused.length) fail(`defined but never used: ${unused.join(", ")}`);
else pass("no dead keys");

// 5 --------------------------------------------------------------------------
console.log("\nhard-coded text");
// Deliberate exceptions: brand names, a Salesforce record label, and internal
// diagnostics we keep in English so they stay searchable in bug reports.
const ALLOWED = [
  /Orgscope/, /Orgscope/,               // brand, and a record label in the org
  /Background call failed/, /Could not read DeployRequest/, // diagnostics: searchable in bug reports
  /\b(SELECT|FROM|WHERE|ORDER BY|LIMIT|COUNT)\b/,    // SOQL
];
const leftovers = [];
for (const file of ["src/panel.js", "src/options.js", "src/apex.js"]) {
  src(file).split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(/["'`]([A-Z][a-zA-Z]+(?: [a-zA-Z,'’-]+){1,10}[.?!]?)["'`<]/g)) {
      const text = m[1];
      if (ALLOWED.some(re => re.test(text))) continue;
      if (/^[A-Z][a-zA-Z]*$/.test(text)) continue;
      leftovers.push(`${file}:${i + 1} — ${text}`);
    }
  });
}
if (leftovers.length) leftovers.forEach(l => fail(l));
else pass("no untranslated sentence-shaped literals");

console.log(failed ? "\ni18n check FAILED\n" : "\ni18n check passed\n");
process.exit(failed ? 1 : 0);
