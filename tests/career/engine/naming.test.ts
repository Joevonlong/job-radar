// @vitest-environment node
import { issuesOf, DAY, resumeFromYaml as parseResume } from "./helpers/fixtures";
import { expect, test } from "vitest";
import { contentDisposition, exportStem } from "../../../src/lib/career/engine/naming";
import { } from "../../../src/lib/career/engine/render";

const resume = (extra: string, name = "Lena Hartmann", meta = "") =>
  parseResume(`meta:\n${meta || "  lang: en\n"}basics: { name: ${name}, title: AI Engineer }\n${extra}`);

test("default name: <First>_<Last>_CV[_<Company>], ASCII-safe, Lebenslauf for German", () => {
  expect(exportStem(resume(""), DAY)).toBe("Lena_Hartmann_CV");
  expect(exportStem(resume("target: { company: Acme Robotics GmbH, role: AI Engineer }"), DAY)).toBe("Lena_Hartmann_CV_Acme-Robotics-GmbH");
  expect(exportStem(resume("", "Jürgen Müller-Weiß", "  lang: de\n"), DAY)).toBe("Juergen_Mueller-Weiss_Lebenslauf");
  expect(exportStem(resume("target: { company: Société Générale }", "José Ñúñez"), DAY)).toBe("Jose_Nunez_CV_Societe-Generale");
  expect(exportStem(resume("", "张三"), DAY)).toBe("张三_CV");
});

test("meta.filename templates; path separators and unknown variables are schema errors", () => {
  const t = (filename: string) => exportStem(resume("target: { company: Acme, role: Senior AI Engineer (m/w/d) }", undefined, `  filename: "${filename}"\n`), "2026-10-09");
  expect(t("{name}_{role}_{date}")).toBe("Lena_Hartmann_Senior-AI-Engineer_2026-10-09");
  expect(t("CV_{name}.pdf")).toBe("CV_Lena_Hartmann");
  expect(issuesOf(`basics: { name: Test, title: Engineer }\nmeta: { filename: "../{name}" }`)).toContainEqual({ path: "meta.filename", code: "career.schema.filename_path" });
  expect(issuesOf(`basics: { name: Test, title: Engineer }\nmeta: { filename: "{name}_{firm}" }`)).toContainEqual(expect.objectContaining({ path: "meta.filename", code: "career.schema.filename_variable_unknown", params: expect.objectContaining({ name: "firm" }) }));
  expect(issuesOf(`basics: { name: Test, title: Engineer }\ntarget: { jd: ../jd.md }`)).toContainEqual({ path: "target.jd", code: "career.schema.path_relative", params: { extension: ".md" } });
});

test("Content-Disposition carries any name", () => {
  expect(contentDisposition("简历.pdf")).toBe(`attachment; filename="__.pdf"; filename*=UTF-8''%E7%AE%80%E5%8E%86.pdf`);
  expect(contentDisposition('a"b.pdf')).toBe(`attachment; filename="a_b.pdf"; filename*=UTF-8''a%22b.pdf`);
});
