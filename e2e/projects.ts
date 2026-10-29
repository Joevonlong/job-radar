import path from "node:path";

/**
 * The Playwright projects of the e2e suite and how a run on named spec files picks among them.
 *
 * Order of a full run:
 *  1. "chromium": every spec that neither rewrites a file of the shared config directory nor is tagged `@exclusive`,
 *     fully parallel.
 *  2. "chromium-exclusive": the tests tagged `@exclusive`, one at a time, after everything parallel. They change state
 *     that every page reads (the visit marker, the seen rows of all jobs) or count whole lists that other specs change
 *     while they run (application status, closures, an inserted job), so they must not overlap any other test.
 *  3. The serial chain: one project per spec that rewrites a config file of the run (settings, interests, sources ...),
 *     each after the one before.
 * With E2E_PART, "parallel" runs only the first two projects; "chain" runs only the serial chain, with no dependency
 * on the exclusive project. Each CI part has its own database and config directory.
 *
 * A dependency project always runs in full (Playwright applies file filters to the projects it was asked for, not to
 * their dependencies). So when the command line names spec files, only the projects with a matching spec take part,
 * each narrowed to the matching specs and chained to the previous one in the order above: `playwright test
 * e2e/settings.spec.ts` runs that spec alone instead of the whole parallel project first.
 */

export const EXCLUSIVE_TAG = "@exclusive";

/** One serial project: its name, the spec file it runs (relative to the test directory) and nothing else. */
interface ChainEntry {
  name: string;
  spec: string;
}

/** The serial chain, in order (see the comments in playwright.config.ts for why each one is there). */
export const SERIAL_CHAIN: readonly ChainEntry[] = [
  // config chain: these rewrite a file of the one shared config directory, or assert on one that others rewrite
  { name: "chromium-config-settings", spec: "settings.spec.ts" },
  { name: "chromium-config-settings-invalid", spec: "settings-invalid.spec.ts" },
  { name: "chromium-config-language", spec: "language.spec.ts" },
  { name: "chromium-config-breakdown", spec: "breakdown.spec.ts" },
  { name: "chromium-config-resume", spec: "resume.spec.ts" },
  // interests.yaml (saved views, accepted suggestions)
  { name: "chromium-interests", spec: "interests.spec.ts" },
  { name: "chromium-interests-suggestions", spec: "interests-suggestions.spec.ts" },
  { name: "chromium-multi-filters", spec: "multi-filters.spec.ts" },
  { name: "chromium-companies", spec: "companies.spec.ts" },
  // config/sources.yaml
  { name: "chromium-sources-registry", spec: "sources-registry.spec.ts" },
  { name: "chromium-sources-discovery", spec: "sources-discovery.spec.ts" },
  // ui / notify / ai / sources / pipeline
  { name: "chromium-settings-advanced", spec: "settings-advanced.spec.ts" },
  { name: "chromium-settings-workflow", spec: "settings-workflow.spec.ts" },
  // Many board applications and a temporary ui.yaml hidden status; counts must not race other specs.
  { name: "chromium-pipeline-many", spec: "pipeline-many.spec.ts" },
  // preferences.yaml deal_breakers, and one job's filter result
  { name: "chromium-deal-breakers", spec: "deal-breakers.spec.ts" },
  // me.yaml needs_visa_sponsorship (the visa badge and filter show only for a user who needs sponsorship)
  { name: "chromium-visa", spec: "visa.spec.ts" },
  // ui.yaml job_checks.ghost (the check is off by default), and one job's dismissal
  { name: "chromium-ghost", spec: "ghost-jobs.spec.ts" },
  // ai.yaml scoring.evidence (the legacy note shows only while reason sources are on)
  { name: "chromium-score-evidence", spec: "score-evidence.spec.ts" },
  // notify.yaml edited by hand while the web runs (the web's on-demand config refresh)
  { name: "chromium-config-refresh", spec: "config-refresh.spec.ts" },
  // the market changes every page and preferences.yaml: last, alone
  { name: "chromium-market", spec: "market.spec.ts" },
];

/** The value-taking options of `playwright test` (1.63): their value is not a spec filter. */
const VALUE_OPTIONS = new Set([
  "--add-reporter",
  "--browser",
  "-c",
  "--config",
  "-g",
  "--grep",
  "-G",
  "--grep-invert",
  "--global-timeout",
  "--last-failed-file",
  "--max-failures",
  "--output",
  "--repeat-each",
  "--reporter",
  "--retries",
  "--run-agents",
  "--shard",
  "--test-list",
  "--test-list-invert",
  "--timeout",
  "--trace",
  "--tsconfig",
  "--ui-host",
  "--ui-port",
  "--update-source-method",
  "-j",
  "--workers",
]);
/** Options with an optional value: the next word is theirs unless it looks like a spec file. */
const OPTIONAL_VALUE_OPTIONS = new Set(["--debug", "--only-changed", "-u", "--update-snapshots"]);
/** Options that take every following word up to the next option. */
const VARIADIC_OPTIONS = new Set(["--project"]);

const looksLikeSpec = (word: string) => /\.spec\.ts(:\d+(:\d+)?)?$|(^|\/)e2e\//.test(word);

/**
 * The test filters (`e2e/foo.spec.ts`, `foo`, `foo.spec.ts:12`) of a `playwright test` command line, or [] when it names
 * none (or is not `playwright test` at all, e.g. a worker process).
 */
export function specFiltersFromArgv(argv: readonly string[]): string[] {
  const testIndex = argv.findIndex((word, i) => word === "test" && i >= 1 && /playwright/.test(argv.slice(0, i).join(" ")));
  if (testIndex < 0) return [];
  const filters: string[] = [];
  let variadic = false;
  for (let i = testIndex + 1; i < argv.length; i += 1) {
    const word = argv[i]!;
    if (word === "--") continue;
    if (word.startsWith("-")) {
      variadic = false;
      if (word.includes("=")) continue;
      if (VALUE_OPTIONS.has(word)) i += 1;
      else if (OPTIONAL_VALUE_OPTIONS.has(word) && i + 1 < argv.length && !argv[i + 1]!.startsWith("-") && !looksLikeSpec(argv[i + 1]!)) i += 1;
      else if (VARIADIC_OPTIONS.has(word)) variadic = true;
      continue;
    }
    if (variadic) continue;
    filters.push(word);
  }
  return filters;
}

/** Playwright's own matching of a command-line filter against a test file: `file[:line[:column]]`, the file part a regular expression. */
function filterMatches(filter: string, absoluteFile: string): boolean {
  const file = /^(.*?):(\d+):?(\d+)?$/.exec(filter)?.[1] ?? filter;
  const literal = /^\/(.*)\/([gi]*)$/.exec(file);
  const re = literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(file, "gi");
  re.lastIndex = 0;
  return re.test(absoluteFile.split(path.sep).join("/"));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A testMatch for exactly these spec files (names relative to the test directory). */
const exactly = (specs: readonly string[]) => new RegExp(`/(${specs.map(escape).join("|")})$`);

export interface ProjectPlan {
  name: string;
  testMatch?: RegExp;
  testIgnore?: RegExp;
  grep?: RegExp;
  grepInvert?: RegExp;
  workers?: number;
  dependencies: string[];
}

/**
 * The projects for a run. `specs` are the spec files of the test directory (names relative to it), `testDir` its
 * absolute path, `filters` the command-line test filters ([] = the whole selected part), `part` the optional E2E_PART
 * value (undefined = the full suite). Part selection happens before filtering, so filters never pull in another part.
 */
export function planProjects(specs: readonly string[], testDir: string, filters: readonly string[], part?: string): ProjectPlan[] {
  if (part !== undefined && part !== "parallel" && part !== "chain") {
    throw new Error(`Invalid E2E_PART ${JSON.stringify(part)}: expected "parallel" or "chain", or leave it unset.`);
  }
  const chainSpecs = new Set(SERIAL_CHAIN.map((entry) => entry.spec));
  const parallelSpecs = specs.filter((spec) => !chainSpecs.has(spec));
  const exclusive = new RegExp(EXCLUSIVE_TAG);
  const chainIgnore = exactly([...chainSpecs]);

  const parallel: ProjectPlan[] = [
    { name: "chromium", testIgnore: chainIgnore, grepInvert: exclusive, dependencies: [] },
    { name: "chromium-exclusive", testIgnore: chainIgnore, grep: exclusive, workers: 1, dependencies: ["chromium"] },
  ];
  const chain: ProjectPlan[] = SERIAL_CHAIN.map((entry, i) => ({
    name: entry.name,
    testMatch: exactly([entry.spec]),
    dependencies: i > 0 ? [SERIAL_CHAIN[i - 1]!.name] : part === "chain" ? [] : ["chromium-exclusive"],
  }));
  const projects = part === "parallel" ? parallel : part === "chain" ? chain : [...parallel, ...chain];
  if (filters.length === 0) return projects;

  const matching = (candidates: readonly string[]) =>
    candidates.filter((spec) => filters.some((filter) => filterMatches(filter, path.join(testDir, spec))));
  // A filter with a line number picks single tests; a dependency would run its whole file instead, so then the selected
  // projects are not chained and every filter applies to each (a test at that line runs, nothing else of its file).
  const chained = !filters.some((filter) => /:\d+(:\d+)?$/.test(filter));
  const selected: ProjectPlan[] = [];
  for (const project of projects) {
    const candidates = project.testMatch ? SERIAL_CHAIN.filter((e) => e.name === project.name).map((e) => e.spec) : parallelSpecs;
    const specsHere = matching(candidates);
    if (specsHere.length === 0) continue;
    const previous = selected.at(-1);
    selected.push({ ...project, testMatch: exactly(specsHere), testIgnore: undefined, dependencies: chained && previous ? [previous.name] : [] });
  }
  return selected;
}
