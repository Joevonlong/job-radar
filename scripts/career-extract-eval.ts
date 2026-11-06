import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";

import { createAiRouter, createDefaultProviders, createProvider } from "../src/lib/ai";
import { loadConfig } from "../src/lib/config";
import { buildCareerExtractPrompt, careerExtractOutputSchema, type CareerExtractOutput } from "../src/lib/career/extract/prompt";
import { draftFields, verifyCareerExtract } from "../src/lib/career/extract/verify";
import { confirmedOutbound, NO_STORED_VALUES } from "../src/lib/outbound/outbound";
import { prepareScrub } from "../src/lib/outbound/scrub";
import { formatOfName, textOfUpload } from "../src/lib/stories/upload-text";

export const SAMPLE_ROOT = path.resolve(import.meta.dirname, "../tests/fixtures/career/samples");
export type FieldScore = { truePositive: number; falsePositive: number; falseNegative: number; precision: number | null; recall: number | null };
type Values = Map<string, string[]>;
const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

/** Quotes are verified separately; values are bound to entry identities and compared as multisets independent of source order. */
function fieldValues(output: CareerExtractOutput): Values {
  const values: Values = new Map();
  const visit = (value: unknown, prefix: string, context = ""): void => {
    if (value == null) return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, prefix, context)); return; }
    if (typeof value === "object") {
      if ("value" in value && typeof value.value === "string") { visit(value.value, prefix, context); return; }
      const anchors: Record<string, string[]> = { experience: ["company"], education: ["school"], projects: ["name"], certifications: ["name"], languages: ["name"], skills: ["group"], custom_sections: ["title"], "custom_sections.items": ["heading", "text"] };
      const anchor = (anchors[prefix] ?? []).map((key) => {
        const part: unknown = Reflect.get(value, key);
        return typeof part === "string" ? part : part && typeof part === "object" && "value" in part && typeof part.value === "string" ? part.value : "";
      }).filter(Boolean).map(normalize).join("|");
      const next = anchor ? `${context}/${prefix}:${anchor}` : context;
      Object.entries(value).forEach(([key, item]) => visit(item, prefix ? `${prefix}.${key}` : key, next));
      return;
    }
    if (typeof value === "string" && value.trim()) values.set(prefix, [...values.get(prefix) ?? [], `${context}\u0000${normalize(value)}`]);
  };
  visit(output, "");
  return values;
}

export function scoreExtraction(expected: CareerExtractOutput, actual: CareerExtractOutput): Record<string, FieldScore> {
  const truth = fieldValues(expected); const predicted = fieldValues(actual);
  return Object.fromEntries([...new Set([...truth.keys(), ...predicted.keys()])].sort().map((field) => {
    const remaining = [...truth.get(field) ?? []];
    let truePositive = 0; let falsePositive = 0;
    for (const value of predicted.get(field) ?? []) {
      const index = remaining.indexOf(value);
      if (index < 0) falsePositive++;
      else { truePositive++; remaining.splice(index, 1); }
    }
    return [field, { truePositive, falsePositive, falseNegative: remaining.length, precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null, recall: truePositive + remaining.length ? truePositive / (truePositive + remaining.length) : null }];
  }));
}

/** Both the chosen source and its answer file must resolve inside the committed fictional sample directory. */
export function samplePath(input: string): string {
  const file = path.resolve(input);
  const inside = (candidate: string) => candidate.startsWith(`${SAMPLE_ROOT}${path.sep}`);
  if (fs.realpathSync(SAMPLE_ROOT) !== SAMPLE_ROOT || !inside(file) || !inside(fs.realpathSync(file)) || !fs.statSync(file).isFile()) throw new Error("sample_only");
  return file;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { dry: { type: "boolean" } }, allowPositionals: true, strict: true });
  const sources = (positionals.length ? positionals : fs.readdirSync(SAMPLE_ROOT).filter((file) => /\.(?:txt|md|pdf)$/.test(file)).map((file) => path.join(SAMPLE_ROOT, file))).map(samplePath);
  const samples = sources.map((file) => {
    if (!formatOfName(file)) throw new Error("sample_only");
    const expectedFile = file.endsWith(".pdf") ? `${file}.expected.yaml` : file.replace(/\.(?:txt|md)$/, ".expected.yaml");
    const expected = careerExtractOutputSchema.parse(parse(fs.readFileSync(samplePath(expectedFile), "utf8")));
    return { file, expected };
  });
  const settings = loadConfig("career");
  const config = structuredClone(loadConfig("ai"));
  if (values.dry) {
    config.order = ["codex-cli"]; config.tasks.career_extract.order = ["codex-cli"];
    config.providers.codex_cli.enabled = true;
  }
  let scriptedReply: CareerExtractOutput | null = null;
  const providers = values.dry ? [createProvider({ id: "codex-cli", availability: () => ({ available: true }), plannedModel: () => "scripted-eval", call: async () => ({ text: JSON.stringify(scriptedReply), model: "scripted-eval", usage: { tokensIn: 0, tokensOut: 0 } }) })] : createDefaultProviders(config);
  const router = createAiRouter({ config, providers, usage: null, health: null, quota: null, origin: "control" });
  const reports: Record<string, FieldScore[]> = {};
  let failed = false;
  console.log(JSON.stringify({ mode: values.dry ? "dry_scripted_expected_answers" : "configured_provider", samples: samples.length, scoring: "normalized_field_value_multisets_by_entry_identity", modelQualityMeasured: !values.dry }));
  for (const sample of samples) {
    try {
      if (fs.statSync(sample.file).size > settings.import.max_file_bytes) throw new Error("too_large");
      const format = formatOfName(sample.file)!;
      const extracted = await textOfUpload(new Uint8Array(fs.readFileSync(sample.file)), format, { maxChars: settings.import.max_chars + 1, minChars: settings.import.min_chars, pdfTimeoutMs: settings.import.pdf_timeout_seconds * 1000, pdfMaxMemoryMb: settings.import.pdf_max_memory_mb });
      if (!extracted.ok) throw new Error(extracted.error);
      const scrubbed = prepareScrub(extracted.text, { stored: NO_STORED_VALUES, rules: settings.import });
      const source = confirmedOutbound(scrubbed.text, NO_STORED_VALUES);
      scriptedReply = sample.expected;
      const result = await router.run("career_extract", buildCareerExtractPrompt({ text: source, quoteMaxChars: settings.evidence.quote_max_chars }), careerExtractOutputSchema, { signal: AbortSignal.timeout(settings.timeout_seconds * 1000) });
      const scores = scoreExtraction(sample.expected, result.value);
      const flags: Record<string, number> = {};
      for (const field of draftFields(verifyCareerExtract(source, result.value, settings.evidence))) for (const flag of field.flags) flags[flag] = (flags[flag] ?? 0) + 1;
      for (const [field, score] of Object.entries(scores)) (reports[field] ??= []).push(score);
      console.log(JSON.stringify({ sample: path.basename(sample.file), provider: result.provider, truncated: scrubbed.truncated, fields: scores, flags }));
    } catch {
      failed = true;
      const scores = scoreExtraction(sample.expected, careerExtractOutputSchema.parse({}));
      for (const [field, score] of Object.entries(scores)) (reports[field] ??= []).push(score);
      console.log(JSON.stringify({ sample: path.basename(sample.file), error: "evaluation_failed", fields: scores }));
    }
  }
  const total = Object.fromEntries(Object.entries(reports).map(([field, scores]) => {
    const truePositive = scores.reduce((sum, item) => sum + item.truePositive, 0);
    const falsePositive = scores.reduce((sum, item) => sum + item.falsePositive, 0);
    const falseNegative = scores.reduce((sum, item) => sum + item.falseNegative, 0);
    return [field, { truePositive, falsePositive, falseNegative, precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null, recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null }];
  }));
  console.log(JSON.stringify({ total }));
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => { console.error(JSON.stringify({ error: "evaluation_refused" })); process.exitCode = 1; });
}
