import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { adoptDraft } from "@/lib/career/extract/adopt";
import { draftFields } from "@/lib/career/extract/verify";
import { importKitYaml } from "@/lib/career/import/kit-yaml";
import { emptyProfile } from "@/lib/career/schema/profile";
import { resumeSchema } from "@/lib/config/schemas/resume";

const sample = fs.readFileSync(path.join(import.meta.dirname, "../fixtures/career/sample.en.yaml"), "utf8");

function imported(text = sample) {
  const result = importKitYaml(text);
  if (!result.ok) throw new Error("expected a valid file");
  return result.result;
}

test("contact values are separated from profile content and the draft carries none of them", () => {
  const kit = imported();
  expect(kit.contact).toMatchObject({ name: "Lena Hartmann", email: "lena.hartmann@example.com", phone: "+49 30 0000000", work_auth: "EU citizen", location: "Berlin, Germany" });
  expect(kit.contact.links.map((link) => link.label)).toEqual(["GitHub", "LinkedIn", "Portfolio"]);
  const draft = JSON.stringify(kit.sections);
  for (const value of ["Lena Hartmann", "lena.hartmann@example.com", "+49 30 0000000", "EU citizen", "github.com/example"]) expect(draft).not.toContain(value);
  expect(kit.sections.headline?.value).toBe("AI Engineer — LLM applications & agents");
  expect(kit.sections.experience.map((entry) => entry.fields.company?.value)).toEqual(["Northwind Analytics", "Fieldline", expect.any(String)].slice(0, kit.sections.experience.length));
  expect(draftFields(kit.sections).every((field) => field.quote === "" && field.flags.length === 0)).toBe(true);
  expect(kit.layout).toEqual({ lang: "en", theme: "minimal", accent: "#2f54eb", pages: 1, paper: "a4", density: "normal" });
  expect(kit.skipped).toEqual(["approach"]);
});

test("adopting the draft writes imported wordings and no contact fields", () => {
  const kit = imported();
  const draft = { schema_version: 1 as const, request_id: 1700000000000, origin: "imported" as const, source_hash: "a".repeat(64), created_at: "2026-01-01T00:00:00Z", language: kit.language, sections: kit.sections };
  const decisions = [{ key: "headline", action: "new" as const }, ...kit.sections.experience.map((entry) => ({ key: entry.key, action: "new" as const }))];
  const profile = adoptDraft(emptyProfile(), draft, decisions);
  expect(profile.experience[0]?.role.wordings[0]?.origin).toBe("imported");
  expect(profile.headline?.wordings[0]?.origin).toBe("imported");
  expect(JSON.stringify(profile)).not.toContain("lena.hartmann@example.com");
});

test("invalid files yield a code only and never echo content", () => {
  for (const text of ["basics: [unterminated", stringify({ basics: { title: "No name Private Sentinel" } }), "\u0000"]) {
    const result = importKitYaml(text);
    expect(result).toEqual({ ok: false, code: "kit_invalid" });
  }
});

test("multi-line addresses join, page counts beyond the profile limit are left out and unsupported parts are counted", () => {
  const kit = imported(stringify({
    meta: { lang: "de", theme: "band", pages: 30 },
    basics: { name: "N", title: "T", photo: "me.jpg", address: ["Line one", "Line two"] },
    certifications: [{ name: "Cert", date: 2020 }],
    letter: { body: ["Hello"] },
  }));
  expect(kit.layout).toEqual({ lang: "de", theme: "band", accent: "#2f54eb", paper: "a4", density: "normal" });
  expect(kit.contact.address).toBe("Line one\nLine two");
  expect(kit.sections.certifications[0]?.fields.date?.value).toBe("2020");
  expect(kit.skipped).toEqual(["photo", "letter"]);
});

test("the resume-kit hand-off configuration keeps its fields", () => {
  expect(Object.keys(resumeSchema.shape)).toEqual([
    "resume_kit_path", "master_resume_path", "pdf_dir", "jd_export_dir", "jd_export_host_dir", "claude_command", "claude_args",
    "filename_part_max_chars", "signal_quote_max_chars", "pdf_list_limit",
  ]);
});
