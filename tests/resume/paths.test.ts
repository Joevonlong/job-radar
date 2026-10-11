// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { exportFileName, isoDateIn, listPdfs, resolveAllowedPdf, slugify } from "@/lib/resume/paths";
import { pdfDisplayName } from "@/lib/resume/types";

describe("slugify", () => {
  it("folds accents, drops punctuation and lower-cases", () => {
    expect(slugify("Müller & Söhne GmbH", 48)).toBe("muller-sohne-gmbh");
    expect(slugify("Senior AI/ML Engineer (m/w/d)", 48)).toBe("senior-ai-ml-engineer-m-w-d");
    expect(slugify("Straße", 48)).toBe("strasse");
  });

  it("cuts to the limit without a trailing dash", () => {
    expect(slugify("abcdef ghij", 7)).toBe("abcdef");
    expect(slugify("a".repeat(100), 10)).toHaveLength(10);
  });

  it("returns an empty string when nothing usable is left", () => {
    expect(slugify("工程师", 48)).toBe("");
    expect(slugify("../..", 48)).toBe("");
  });

  it("never yields path separators or dots", () => {
    for (const evil of ["../../etc/passwd", "a/b\\c", "..", "x\0y", "~root", "$(rm -rf)"]) {
      expect(slugify(evil, 48)).toMatch(/^[a-z0-9-]*$/);
    }
  });
});

describe("exportFileName", () => {
  it("is <company>-<title>-<date>.md", () => {
    expect(exportFileName({ company: "Acme GmbH", title: "AI Engineer", date: "2026-10-07", maxPartChars: 48 })).toBe("acme-gmbh-ai-engineer-2026-10-07.md");
  });

  it("uses a placeholder for a part without usable characters and an optional job id suffix", () => {
    expect(exportFileName({ company: "Acme", title: "工程师", date: "2026-10-07", maxPartChars: 48 })).toBe("acme-untitled-2026-10-07.md");
    expect(exportFileName({ company: "Acme", title: "AI", date: "2026-10-07", maxPartChars: 48, jobIdSuffix: 12 })).toBe("acme-ai-2026-10-07-12.md");
  });

  it("stays a plain file name for hostile input", () => {
    const name = exportFileName({ company: "../../x", title: "a/b/../c", date: "2026-10-07", maxPartChars: 48 });
    expect(path.basename(name)).toBe(name);
    expect(name).not.toContain("..");
  });
});

describe("isoDateIn", () => {
  it("is the calendar day in the given zone", () => {
    const instant = new Date("2026-10-07T22:30:00Z");
    expect(isoDateIn(instant, "Europe/Berlin")).toBe("2026-10-08");
    expect(isoDateIn(instant, "UTC")).toBe("2026-10-07");
  });
});

describe("pdfDisplayName", () => {
  it("is the last path segment", () => {
    expect(pdfDisplayName("/Users/x/Exports/Acme_AI.pdf")).toBe("Acme_AI.pdf");
    expect(pdfDisplayName("C:\\Exports\\Acme.pdf")).toBe("Acme.pdf");
  });
});

describe("resolveAllowedPdf (path traversal)", () => {
  let root: string;
  let allowed: string;
  let outside: string;
  let sibling: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-pdf-")));
    allowed = path.join(root, "pdfs");
    sibling = path.join(root, "pdfs-evil"); // shares the prefix of the allowed directory
    outside = path.join(root, "secret");
    for (const dir of [allowed, sibling, outside, path.join(allowed, "sub"), path.join(allowed, "dir.pdf")]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(allowed, "Acme.pdf"), "%PDF-1.4");
    fs.writeFileSync(path.join(allowed, "UPPER.PDF"), "%PDF-1.4");
    fs.writeFileSync(path.join(allowed, "sub", "Nested.pdf"), "%PDF-1.4");
    fs.writeFileSync(path.join(allowed, "notes.txt"), "text");
    fs.writeFileSync(path.join(sibling, "Evil.pdf"), "%PDF-1.4");
    fs.writeFileSync(path.join(outside, "Secret.pdf"), "%PDF-1.4");
    fs.symlinkSync(outside, path.join(allowed, "link-out"));
    fs.symlinkSync(path.join(outside, "Secret.pdf"), path.join(allowed, "Linked.pdf"));
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("accepts a file name, a nested relative path and an absolute path inside the directory", async () => {
    expect(await resolveAllowedPdf("Acme.pdf", allowed)).toEqual({ ok: true, path: path.join(allowed, "Acme.pdf") });
    expect(await resolveAllowedPdf("  Acme.pdf  ", allowed)).toEqual({ ok: true, path: path.join(allowed, "Acme.pdf") });
    expect(await resolveAllowedPdf("sub/Nested.pdf", allowed)).toEqual({ ok: true, path: path.join(allowed, "sub", "Nested.pdf") });
    expect(await resolveAllowedPdf(path.join(allowed, "Acme.pdf"), allowed)).toEqual({ ok: true, path: path.join(allowed, "Acme.pdf") });
    expect(await resolveAllowedPdf("UPPER.PDF", allowed)).toEqual({ ok: true, path: path.join(allowed, "UPPER.PDF") });
    // `..` that stays inside is fine
    expect(await resolveAllowedPdf("sub/../Acme.pdf", allowed)).toEqual({ ok: true, path: path.join(allowed, "Acme.pdf") });
  });

  it.each([
    ["../secret/Secret.pdf"],
    ["../pdfs-evil/Evil.pdf"],
    ["sub/../../secret/Secret.pdf"],
    ["../../../../../../etc/passwd.pdf"],
    ["/etc/passwd.pdf"],
    ["./../secret/Secret.pdf"],
  ])("rejects %s as outside", async (input) => {
    expect(await resolveAllowedPdf(input, allowed)).toEqual({ ok: false, error: "outside" });
  });

  it("rejects an absolute path in a directory that merely shares the prefix", async () => {
    expect(await resolveAllowedPdf(path.join(sibling, "Evil.pdf"), allowed)).toEqual({ ok: false, error: "outside" });
    expect(await resolveAllowedPdf(path.join(outside, "Secret.pdf"), allowed)).toEqual({ ok: false, error: "outside" });
  });

  it("rejects the directory itself and a path outside that does not exist the same way as one that does", async () => {
    expect(await resolveAllowedPdf(".", allowed)).toEqual({ ok: false, error: "outside" });
    expect(await resolveAllowedPdf("../secret/Missing.pdf", allowed)).toEqual(await resolveAllowedPdf("../secret/Secret.pdf", allowed));
  });

  it("rejects symlinks that lead out of the directory", async () => {
    expect(await resolveAllowedPdf("Linked.pdf", allowed)).toEqual({ ok: false, error: "outside" });
    expect(await resolveAllowedPdf("link-out/Secret.pdf", allowed)).toEqual({ ok: false, error: "outside" });
  });

  it("rejects empty input, NUL bytes and absurdly long input", async () => {
    expect(await resolveAllowedPdf("", allowed)).toEqual({ ok: false, error: "invalid" });
    expect(await resolveAllowedPdf("   ", allowed)).toEqual({ ok: false, error: "invalid" });
    expect(await resolveAllowedPdf("Acme.pdf\0.txt", allowed)).toEqual({ ok: false, error: "invalid" });
    expect(await resolveAllowedPdf(`${"a".repeat(2000)}.pdf`, allowed)).toEqual({ ok: false, error: "invalid" });
  });

  it("rejects non-PDF files, missing files and directories", async () => {
    expect(await resolveAllowedPdf("notes.txt", allowed)).toEqual({ ok: false, error: "not_pdf" });
    expect(await resolveAllowedPdf("Missing.pdf", allowed)).toEqual({ ok: false, error: "not_found" });
    expect(await resolveAllowedPdf("dir.pdf", allowed)).toEqual({ ok: false, error: "not_found" });
  });

  it("is off while pdf_dir is not configured", async () => {
    expect(await resolveAllowedPdf("Acme.pdf", null)).toEqual({ ok: false, error: "not_configured" });
  });

  it("works through a symlinked allowed directory (e.g. /tmp on macOS)", async () => {
    const alias = path.join(root, "alias");
    fs.symlinkSync(allowed, alias);
    expect(await resolveAllowedPdf("Acme.pdf", alias)).toEqual({ ok: true, path: path.join(alias, "Acme.pdf") });
    expect(await resolveAllowedPdf("../secret/Secret.pdf", alias)).toEqual({ ok: false, error: "outside" });
  });

  it("lists the PDFs of the directory, newest first, within the limit", async () => {
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(allowed, "Acme.pdf"), old, old);
    const names = (await listPdfs(allowed, 10)).map((p) => p.name);
    expect(names).toContain("Acme.pdf");
    expect(names).toContain("UPPER.PDF");
    expect(names).not.toContain("notes.txt");
    expect(names).not.toContain("Nested.pdf");
    expect(names.indexOf("Acme.pdf")).toBeGreaterThan(names.indexOf("UPPER.PDF"));
    expect(await listPdfs(allowed, 1)).toHaveLength(1);
    expect(await listPdfs(null, 10)).toEqual([]);
    expect(await listPdfs(path.join(root, "missing"), 10)).toEqual([]);
  });
});
