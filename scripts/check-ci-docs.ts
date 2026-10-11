/**
 * Keeps docs/ci.md bound to the CI: every job and every step of every workflow under .github/workflows/ must be documented
 * there, nothing may be documented that no longer exists, and docs/ci.zh.md must cover the same jobs and steps.
 *
 * Format the check reads (see docs/ci.md):
 *   ### Job `<job id>`        one heading per job (the key under `jobs:`)
 *   #### <step name>          one heading per step, under its job, spelled exactly like the step's `name:`
 *   ### Dependabot ecosystems  (optional section) every `package-ecosystem` of .github/dependabot.yml appears in backticks
 *
 * Usage: pnpm ci:docs-check   (exit 1 lists exactly what to change)
 */
import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

export type JobInventory = Map<string, string[]>; // job id -> step names in order

const WORKFLOWS_DIR = ".github/workflows";
const DOC_EN = "docs/ci.md";
const DOC_ZH = "docs/ci.zh.md";
const DEPENDABOT = ".github/dependabot.yml";

/** Jobs and step names of the workflow files; problems (unnamed step, duplicate id) go into `errors`. */
export function inventoryOf(workflows: { file: string; text: string }[]): { jobs: JobInventory; errors: string[] } {
  const jobs: JobInventory = new Map();
  const owner = new Map<string, string>();
  const errors: string[] = [];
  for (const { file, text } of workflows) {
    let doc: unknown;
    try {
      doc = parse(text);
    } catch (err) {
      errors.push(`${file}: not valid YAML (${(err as Error).message.split("\n")[0]})`);
      continue;
    }
    const defined = (doc as { jobs?: Record<string, { steps?: unknown[] }> } | null)?.jobs ?? {};
    for (const [id, job] of Object.entries(defined)) {
      if (owner.has(id)) {
        errors.push(`${file}: job id "${id}" is also defined in ${owner.get(id)}; job ids must be unique across workflows (docs/ci.md uses them as headings), rename one`);
        continue;
      }
      owner.set(id, file);
      const names: string[] = [];
      (job.steps ?? []).forEach((step, i) => {
        const name = (step as { name?: unknown } | null)?.name;
        if (typeof name !== "string" || name.trim() === "") {
          errors.push(`${file}: job "${id}", step ${i + 1} has no \`name:\`; give every step a name (it is documented under that name in ${DOC_EN})`);
        } else if (names.includes(name)) {
          errors.push(`${file}: job "${id}" has two steps named "${name}"; step names must be unique within a job`);
        } else names.push(name);
      });
      jobs.set(id, names);
    }
  }
  return { jobs, errors };
}

/** Jobs and steps a documentation file declares through its headings (code fences are ignored). */
export function documentedIn(markdown: string): { jobs: JobInventory; dependabot: string } {
  const jobs: JobInventory = new Map();
  let current: string[] | null = null;
  let inFence = false;
  let inDependabot = false;
  let dependabot = "";
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (inDependabot) dependabot += `${line}\n`;
      continue;
    }
    if (inFence) {
      if (inDependabot) dependabot += `${line}\n`;
      continue;
    }
    const job = /^###\s+Job\s+`([^`]+)`/.exec(line);
    const step = /^####\s+(.+?)\s*$/.exec(line);
    if (job) {
      current = jobs.get(job[1]!) ?? [];
      jobs.set(job[1]!, current);
      inDependabot = false;
    } else if (step && current) {
      current.push(step[1]!);
    } else if (/^#{1,3}\s/.test(line)) {
      current = null;
      inDependabot = /^#{1,3}\s+Dependabot\b/i.test(line);
    }
    if (inDependabot) dependabot += `${line}\n`;
  }
  return { jobs, dependabot };
}

/** What differs between the workflows and one documentation file. */
export function compareWithDoc(doc: string, actual: JobInventory, documented: JobInventory): string[] {
  const errors: string[] = [];
  for (const [id, steps] of actual) {
    const docSteps = documented.get(id);
    if (!docSteps) {
      errors.push(`${doc}: job "${id}" is in the workflows but not documented. Add the heading "### Job \`${id}\`" with a "#### <step name>" heading for each of its steps (${steps.map((s) => `"${s}"`).join(", ") || "no steps"}).`);
      continue;
    }
    for (const step of steps) {
      if (!docSteps.includes(step)) errors.push(`${doc}: step "${step}" of job "${id}" is not documented. Add "#### ${step}" under "### Job \`${id}\`".`);
    }
    for (const step of docSteps) {
      if (!steps.includes(step)) errors.push(`${doc}: documents step "${step}" under job "${id}", but the workflow has no such step. Rename or remove that "#### ${step}" heading (the workflow step names are: ${steps.map((s) => `"${s}"`).join(", ")}).`);
    }
  }
  for (const id of documented.keys()) {
    if (!actual.has(id)) errors.push(`${doc}: documents job "${id}", but no workflow defines it. Remove or rename the "### Job \`${id}\`" section.`);
  }
  return errors;
}

/** The zh mirror must carry the same jobs and steps as the English document (the headings are identifiers, kept in English). */
export function compareMirror(en: JobInventory, zh: JobInventory): string[] {
  const errors: string[] = [];
  for (const [id, steps] of en) {
    const other = zh.get(id);
    if (!other) {
      errors.push(`${DOC_ZH}: job "${id}" is documented in ${DOC_EN} but missing here. Add the heading "### Job \`${id}\`" (and the translated section).`);
      continue;
    }
    for (const step of steps) if (!other.includes(step)) errors.push(`${DOC_ZH}: step "${step}" of job "${id}" is in ${DOC_EN} but missing here. Add "#### ${step}" under "### Job \`${id}\`".`);
    for (const step of other) if (!steps.includes(step)) errors.push(`${DOC_ZH}: has step "${step}" under job "${id}" that ${DOC_EN} does not. Make both documents list the same steps.`);
  }
  for (const id of zh.keys()) if (!en.has(id)) errors.push(`${DOC_ZH}: documents job "${id}" which ${DOC_EN} does not. Make both documents list the same jobs.`);
  return errors;
}

/** Every package ecosystem Dependabot watches must be named (in backticks) in the Dependabot section. */
export function dependabotErrors(dependabotYaml: string | null, section: string, doc: string): string[] {
  if (dependabotYaml === null) return [];
  const updates = ((parse(dependabotYaml) as { updates?: { "package-ecosystem"?: string }[] } | null)?.updates ?? []);
  const errors: string[] = [];
  for (const u of updates) {
    const eco = u["package-ecosystem"];
    if (eco && !section.includes(`\`${eco}\``)) errors.push(`${doc}: Dependabot ecosystem "${eco}" (${DEPENDABOT}) is not documented. Mention \`${eco}\` in the "Dependabot" section.`);
  }
  return errors;
}

export function checkCiDocs(root: string): string[] {
  const dir = path.join(root, WORKFLOWS_DIR);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const { jobs, errors } = inventoryOf(files.map((f) => ({ file: `${WORKFLOWS_DIR}/${f}`, text: fs.readFileSync(path.join(dir, f), "utf8") })));
  const read = (rel: string) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : null);
  const en = read(DOC_EN);
  const zh = read(DOC_ZH);
  if (en === null) errors.push(`${DOC_EN} is missing: document every CI job and step there (see CONTRIBUTING.md).`);
  if (zh === null) errors.push(`${DOC_ZH} is missing: it mirrors the jobs and steps of ${DOC_EN}.`);
  if (en !== null) {
    const parsed = documentedIn(en);
    errors.push(...compareWithDoc(DOC_EN, jobs, parsed.jobs), ...dependabotErrors(read(DEPENDABOT), parsed.dependabot, DOC_EN));
    if (zh !== null) errors.push(...compareMirror(parsed.jobs, documentedIn(zh).jobs));
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const root = path.resolve(import.meta.dirname, "..");
  const errors = checkCiDocs(root);
  if (errors.length > 0) {
    console.error(`ci-docs-check: ${errors.length} problem(s) between the CI and ${DOC_EN} / ${DOC_ZH}:`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`Changing a workflow means updating ${DOC_EN} and ${DOC_ZH} in the same pull request.`);
    process.exit(1);
  }
  console.log("ci-docs-check: workflows and docs/ci.md / docs/ci.zh.md agree");
}
