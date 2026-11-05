// @vitest-environment node
import { expect, test } from "vitest";
import { contentDisposition, exportStem } from "../../../src/lib/career/engine/naming";
import { parseResume } from "../../../src/lib/career/engine/render";

const resume = (extra: string, name = "Lena Hartmann", meta = "") =>
  parseResume(`meta:\n${meta || "  lang: en\n"}basics: { name: ${name}, title: AI Engineer }\n${extra}`);

test("default name: <First>_<Last>_CV[_<Company>], ASCII-safe, Lebenslauf for German", () => {
  expect(exportStem(resume(""))).toBe("Lena_Hartmann_CV");
  expect(exportStem(resume("target: { company: Acme Robotics GmbH, role: AI Engineer }"))).toBe("Lena_Hartmann_CV_Acme-Robotics-GmbH");
  expect(exportStem(resume("", "Jürgen Müller-Weiß", "  lang: de\n"))).toBe("Juergen_Mueller-Weiss_Lebenslauf");
  expect(exportStem(resume("target: { company: Société Générale }", "José Ñúñez"))).toBe("Jose_Nunez_CV_Societe-Generale");
  expect(exportStem(resume("", "张三"))).toBe("张三_CV");
});

test("meta.filename templates; path separators and unknown variables are schema errors", () => {
  const t = (filename: string) => exportStem(resume("target: { company: Acme, role: Senior AI Engineer (m/w/d) }", undefined, `  filename: "${filename}"\n`), "2026-10-09");
  expect(t("{name}_{role}_{date}")).toBe("Lena_Hartmann_Senior-AI-Engineer_2026-10-09");
  expect(t("CV_{name}.pdf")).toBe("CV_Lena_Hartmann");
  expect(() => t("../{name}")).toThrow(/can't contain \/ or \\/);
  expect(() => t("{name}_{firm}")).toThrow(/unknown variable \{firm\}/);
  expect(() => resume("target: { jd: ../jd.md }")).toThrow(/workspace-relative/);
});

test("Content-Disposition carries any name", () => {
  expect(contentDisposition("简历.pdf")).toBe(`attachment; filename="__.pdf"; filename*=UTF-8''%E7%AE%80%E5%8E%86.pdf`);
  expect(contentDisposition('a"b.pdf')).toBe(`attachment; filename="a_b.pdf"; filename*=UTF-8''a%22b.pdf`);
});
