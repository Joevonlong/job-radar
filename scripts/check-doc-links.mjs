/**
 * Checks the relative links of the documentation: every `[text](target)` and every `src="…"` / `srcset="…"` (inline HTML
 * images and `<picture>` sources) in the Markdown files, and every `href` / `src` / `srcset` in the HTML guides under
 * docs/ (and the top-level *.md files) must point to an existing file; `#anchors` and absolute URLs are not followed.
 * Plain Node, no dependencies. Run with `pnpm docs:check [root]` (default: the repository); exit code 1 lists the broken
 * links.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? path.resolve(import.meta.dirname, ".."));
const SKIP_DIRS = new Set(["node_modules", ".next", "data", ".git", "dist", "drizzle", "tests", "src", "e2e", "jobspy"]);

/** @param {string} dir @param {string[]} out @returns {string[]} */
function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) collect(path.join(dir, entry.name), out);
    } else if (/\.(md|html)$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}

/**
 * The URLs of a `srcset` value: comma-separated candidates, each a URL and an optional width / density descriptor.
 * @param {string} value @returns {string[]}
 */
function srcsetUrls(value) {
  return value
    .split(/,\s+|,(?=\S)/)
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((url) => url !== "");
}

/** @param {string} text @param {boolean} withHref @returns {string[]} */
function htmlTargets(text, withHref) {
  /** @type {string[]} */
  const found = [];
  const attrs = withHref ? "href|src|srcset" : "src|srcset";
  for (const m of text.matchAll(new RegExp(`\\s(${attrs})=(?:"([^"]*)"|'([^']*)')`, "g"))) {
    const value = m[2] ?? m[3] ?? "";
    if (m[1] === "srcset") found.push(...srcsetUrls(value));
    else found.push(value);
  }
  return found;
}

/** @param {string} file @param {string} text @returns {string[]} */
function targetsOf(file, text) {
  /** @type {string[]} */
  const found = [];
  if (file.endsWith(".md")) {
    const noCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    for (const m of noCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push(m[1] ?? "");
    found.push(...htmlTargets(noCode, false));
  } else {
    found.push(...htmlTargets(text, true));
  }
  return found;
}

/** @type {string[]} */
const broken = [];
let checked = 0;
for (const file of collect(root, [])) {
  const text = fs.readFileSync(file, "utf8");
  for (const raw of targetsOf(file, text)) {
    if (raw === "" || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) continue;
    const target = decodeURIComponent(raw.split("#")[0]?.split("?")[0] ?? "");
    if (target === "") continue;
    checked += 1;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) broken.push(`${path.relative(root, file)}: ${raw}`);
  }
}

if (broken.length > 0) {
  console.error(`docs:check: ${broken.length} broken relative link(s):\n${broken.map((b) => `  ${b}`).join("\n")}`);
  process.exit(1);
}
console.log(`docs:check: ${checked} relative links ok`);
