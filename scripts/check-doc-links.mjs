/**
 * Checks the relative links of the documentation: every `[text](target)` and every `src="…"` / `srcset="…"` (inline HTML
 * images and `<picture>` sources) in the Markdown files, and every `href` / `src` / `srcset` in the HTML guides under
 * docs/ (and the top-level *.md files) must point to an existing file; `#anchors` and absolute URLs are not followed.
 * Also checks the references in code, config and prose: a path under one of REFERENCE_ROOTS, and in a comment a Markdown
 * file name without a directory, must exist in the repository, because a reader cannot open anything else. Outside comments
 * only a path with a file extension counts (a pair of words with a slash is not a path). Under the test directories only comments
 * count (test data holds made-up paths), and saved pages and JSON there are skipped.
 * Plain Node, no dependencies. Run with `pnpm docs:check [root]` (default: the repository); exit code 1 lists the broken
 * links and references.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? path.resolve(import.meta.dirname, ".."));
const SKIP_DIRS = new Set(["node_modules", ".next", "data", ".git", "dist", "drizzle", "tests", "src", "e2e", "jobspy"]);
const REFERENCE_SKIPPED = /^(data|dist|drizzle|licenses)\/|(^|\/)node_modules\/|(^|\/)\.(?!github\/)[^/]+\//;
const REFERENCE_SKIP_FILES = new Set(["pnpm-lock.yaml"]);
const REFERENCE_ROOTS = "docs|research|spec|dev-notes|tracking|planning|changes|vision|marketing|promo|requirements|site|job-radar-workspace";
const PATH_REFERENCE = new RegExp(`(?:^|[^\\w./@:-])((?:\\.\\.?/)*(?:${REFERENCE_ROOTS})/[\\w./-]*[\\w-])`, "g");
const BARE_MARKDOWN = /(?:^|[^\w./@:-])([A-Za-z0-9][\w.-]*\.md)\b/g;
const HAS_EXTENSION = /\.\w+$/;
/** Files of other projects that a comment may name: the skill of resume-kit. */
const OTHER_PROJECT_FILES = new Set(["SKILL.md"]);
const SCANNED_FILE = /(\.(ts|tsx|mts|cts|js|mjs|cjs|css|sh|py|ya?ml|toml|json|md|html)|(^|\/)\.env\.example|(^|\/)Dockerfile[^/]*)$/;
const PROSE_FILE = /\.(md|html)$/;
const HASH_COMMENT_FILE = /(\.(sh|py|ya?ml|toml)|(^|\/)\.env\.example|(^|\/)Dockerfile[^/]*)$/;
const TEST_FILE = /^(tests|e2e|e2e-demo|e2e-setup|jobspy\/tests)\//;
const REFERENCE_SUFFIXES = ["", ".md", ".html", ".ts", ".tsx", ".mjs"];

/** Whether a file can be read; a broken or looping symlink cannot. @param {string} file @returns {boolean} */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** @param {string} dir @param {string[]} out @returns {string[]} */
function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) collect(path.join(dir, entry.name), out);
    } else if (/\.(md|html)$/.test(entry.name) && isFile(path.join(dir, entry.name))) out.push(path.join(dir, entry.name));
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

/** @param {string} dir @param {string[]} out @returns {string[]} */
function walkForReferences(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.relative(root, path.join(dir, entry.name));
    if (!entry.isDirectory()) out.push(relative);
    else if (!REFERENCE_SKIPPED.test(`${relative}/`)) walkForReferences(path.join(dir, entry.name), out);
  }
  return out;
}

/**
 * The files of the reference check, as absolute paths: what git tracks plus new files it does not ignore, so ignored local
 * folders never count; a walk outside a repository. Of the hidden directories only .github is published source.
 * @returns {string[]}
 */
function collectForReferences() {
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const names = listed.status === 0 ? listed.stdout.split("\0").filter((name) => name !== "") : walkForReferences(root, []);
  return names
    .filter((name) => !REFERENCE_SKIPPED.test(name))
    .map((name) => path.join(root, name))
    .filter(isFile);
}

/**
 * The comment text of each line. Line based and without a parser: a comment marker inside a string counts when whitespace
 * comes before it, which at worst checks a little more text.
 * @param {string} text @param {boolean} hashComments @returns {[number, string][]}
 */
function commentLines(text, hashComments) {
  /** @type {[number, string][]} */
  const found = [];
  let inBlock = false;
  text.split("\n").forEach((line, index) => {
    if (hashComments) {
      const hash = line.match(/(?:^|\s)#(.*)$/);
      if (hash) found.push([index + 1, hash[1] ?? ""]);
      return;
    }
    if (inBlock) {
      const end = line.indexOf("*/");
      inBlock = end < 0;
      found.push([index + 1, end < 0 ? line : line.slice(0, end)]);
      if (end < 0) return;
      line = line.slice(end + 2);
    }
    const open = line.search(/(?:^|[\s{])\/\*/);
    if (open >= 0) {
      found.push([index + 1, line.slice(open)]);
      inBlock = !line.slice(open).includes("*/");
    }
    const single = line.match(/(?:^|\s)\/\/(.*)$/);
    if (single) found.push([index + 1, single[1] ?? ""]);
  });
  return found;
}

/** @param {string} file @param {string} target @returns {boolean} */
function referenceExists(file, target) {
  return [root, path.dirname(file)].some((base) => REFERENCE_SUFFIXES.some((suffix) => fs.existsSync(path.resolve(base, target + suffix))));
}

/** @type {string[]} */
const unresolved = [];
let referencesChecked = 0;
const referenceFiles = collectForReferences();
const fileNames = new Set(referenceFiles.map((file) => path.basename(file)));
for (const file of referenceFiles) {
  const relative = path.relative(root, file);
  const isTest = TEST_FILE.test(relative);
  const isProse = PROSE_FILE.test(file);
  if (!SCANNED_FILE.test(file) || REFERENCE_SKIP_FILES.has(path.basename(file))) continue;
  if (isTest && (file.endsWith(".html") || file.endsWith(".json"))) continue;
  const text = fs.readFileSync(file, "utf8");
  const comments = isProse || file.endsWith(".json") ? [] : commentLines(text, HASH_COMMENT_FILE.test(file));
  const commentNumbers = new Set(comments.map(([lineNumber]) => lineNumber));
  /** @type {[number, string][]} */
  const lines = isTest && !isProse ? comments : text.split("\n").map((line, index) => [index + 1, line]);
  for (const [lineNumber, line] of lines) {
    for (const m of line.matchAll(PATH_REFERENCE)) {
      const target = m[1] ?? "";
      if (!commentNumbers.has(lineNumber) && !HAS_EXTENSION.test(target)) continue;
      referencesChecked += 1;
      if (!referenceExists(file, target)) unresolved.push(`${relative}:${lineNumber}: ${target}`);
    }
  }
  for (const [lineNumber, line] of comments) {
    for (const m of line.matchAll(BARE_MARKDOWN)) {
      const name = m[1] ?? "";
      referencesChecked += 1;
      if (!fileNames.has(name) && !OTHER_PROJECT_FILES.has(name)) unresolved.push(`${relative}:${lineNumber}: ${name}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`docs:check: ${broken.length} broken relative link(s):\n${broken.map((b) => `  ${b}`).join("\n")}`);
}
if (unresolved.length > 0) {
  console.error(
    `docs:check: ${unresolved.length} reference(s) to a file that is not in the repository; fix the path, or state the fact instead of citing it:\n${unresolved.map((u) => `  ${u}`).join("\n")}`,
  );
}
if (broken.length > 0 || unresolved.length > 0) process.exit(1);
console.log(`docs:check: ${checked} relative links ok, ${referencesChecked} path references ok`);
