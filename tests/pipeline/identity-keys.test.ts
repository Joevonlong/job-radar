// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeCompanyKey, resolveCompanyName } from "@/lib/pipeline/company";
import { legacyCompanyKey, legacyTitleKey } from "@/lib/pipeline/identity-keys";
import { normalizeTitle } from "@/lib/pipeline/normalize";

import { pipelineWith, shippedPipeline } from "./helpers";

const config = shippedPipeline();
const suffixes = config.company.legal_suffixes;
const companyKey = (name: string) => normalizeCompanyKey(name, suffixes);

const FIXTURES = path.join(__dirname, "..", "fixtures");

/** Every string of the JSON fixtures (channel payloads, golden inputs, ...), short enough to be a name or a title. */
function fixtureStrings(): string[] {
  const out = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length <= 300) out.add(value);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
  };
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".json")) collect(JSON.parse(fs.readFileSync(file, "utf8")));
    }
  };
  walk(FIXTURES);
  return [...out];
}

/** Inputs of the existing key tables (company.test.ts, normalize.test.ts, company-filter-keys.test.ts). */
const TABLE_INPUTS = [
  "Signal Works GmbH", "SIGNAL Works, G.m.b.H.", "Signal Works Labs", "Acme AI", "Northwind Labs GmbH", "Fabrikam Software AG",
  "Modehaus SE", "Acme Inc.", "Acme, Inc", "Contoso Ltd", "Contoso Limited", "Beispiel GmbH & Co. KG", "Beispiel GmbH & Co KG",
  "Müller & Söhne UG (haftungsbeschränkt)", "Société Générale S.A.", "Initech LLC", "AG", "SE", "Alphabet Inc.", "Google Deutschland GmbH",
  "ZALANDO SE", "Oldbrand GmbH", "Applied AI Engineer (m/w/d)", "Applied AI Engineer (f/m/x)", "Applied AI Engineer m/f/d",
  "Applied AI Engineer (all genders)", "  Applied   AI-Engineer  ", "KI-Entwickler:in", "KI-Entwickler*in (m/w/d)", "Datenwissenschaftler/in",
  "Größe & Übung Engineer", "C++ Engineer", "CI/CD Engineer", "C# Developer", "R&D Lead", "Senior Data Scientist (w/m/d) – NLP",
];

/**
 * Whether every letter and digit of the text is a Latin letter that folds to a-z (accents removed) or an ASCII digit: the
 * text key version 1 already handled. `extra` admits letters a key folds itself (`ß` -> `ss` in titles).
 */
function latinOnly(text: string, extra: RegExp | null): boolean {
  for (const ch of text.normalize("NFKD").replace(/\p{M}/gu, "")) {
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    if (/[A-Za-z0-9]/.test(ch) || (extra !== null && extra.test(ch))) continue;
    return false;
  }
  return true;
}

describe("identity keys in Latin script are unchanged", () => {
  const corpus = [...new Set([...TABLE_INPUTS, ...fixtureStrings()])];

  it("company keys equal the previous version for every Latin-script fixture string without ß", () => {
    // a name without any letter or digit ("!!!", "💰") keyed as "" before; it has its own key now (tested below)
    const latin = corpus.filter((text) => latinOnly(text, null) && legacyCompanyKey(text, suffixes) !== "");
    expect(latin.length).toBeGreaterThan(5000);
    const differing = latin.filter((text) => companyKey(text) !== legacyCompanyKey(text, suffixes));
    expect(differing).toEqual([]);
  });

  it("company names with ß differ from the previous version only by ß -> ss (it was a word break: \"stra-e\")", () => {
    const withSharpS = corpus.filter((text) => /[ßẞ]/.test(text) && latinOnly(text.replace(/[ßẞ]/g, "ss"), null));
    expect(withSharpS.length).toBeGreaterThan(5);
    for (const text of withSharpS) expect(companyKey(text)).toBe(legacyCompanyKey(text.replace(/[ßẞ]/g, "ss"), suffixes));
    expect(companyKey("Straße GmbH")).toBe(companyKey("Strasse GmbH"));
    expect(companyKey("Straße GmbH")).toBe("strasse");
    expect(companyKey("GROẞHANDEL AG")).toBe("grosshandel");
  });

  it("title keys equal the previous version for every Latin-script fixture string", () => {
    const latin = corpus.filter((text) => latinOnly(text, /ß/));
    expect(latin.length).toBeGreaterThan(5000);
    const differing = latin.filter((text) => normalizeTitle(text) !== legacyTitleKey(text));
    expect(differing).toEqual([]);
  });

  it("the existing key rules still hold", () => {
    expect(normalizeTitle("Größe & Übung Engineer")).toBe("grosse and ubung engineer");
    expect(normalizeTitle("Straßenbau Ingenieur")).toBe(normalizeTitle("Strassenbau Ingenieur"));
    expect(normalizeTitle("KI-Entwickler*in (m/w/d)")).toBe("ki entwickler");
    expect(companyKey("SIGNAL Works, G.m.b.H.")).toBe("signal-works");
    expect(companyKey("Beispiel GmbH & Co. KG")).toBe("beispiel");
    expect(companyKey("Müller & Söhne UG (haftungsbeschränkt)")).toBe("muller-and-sohne-ug-haftungsbeschrankt");
  });
});

describe("identity keys in other scripts", () => {
  const companies = [
    "Яндекс", "ООО «Ромашка»", "株式会社メルカリ", "华为技术有限公司", "Πειραιώς Τράπεζα", "חברת החשמל", "삼성전자", "شركة أرامكو",
    "Ørsted A/S", "Orsted A/S", "Łukasiewicz", "Lukasiewicz", "Mærsk", "Đông Á",
  ];
  const titles = [
    "バックエンドエンジニア", "プロダクトデザイナー", "シニアAIエンジニア", "AIリサーチャー", "Разработчик", "Аналитик данных",
    "Μηχανικός Λογισμικού", "מהנדס תוכנה", "软件工程师", "数据科学家", "백엔드 개발자", "Programista Łódź", "Programista Lodz", "Udvikler Ørsted",
  ];

  it("company names keep a key of their own: non-empty and all different", () => {
    const keys = companies.map(companyKey);
    for (const key of keys) expect(key).not.toBe("");
    expect(new Set(keys).size).toBe(companies.length);
    expect(companyKey("Яндекс")).toBe("яндекс");
    expect(companyKey("Ørsted A/S")).toBe("ørsted-a-s");
    expect(companyKey("Łukasiewicz")).toBe("łukasiewicz");
  });

  it("titles keep a key of their own: non-empty and all different", () => {
    const keys = titles.map(normalizeTitle);
    for (const key of keys) expect(key).not.toBe("");
    expect(new Set(keys).size).toBe(titles.length);
    expect(normalizeTitle("シニアAIエンジニア")).not.toBe(normalizeTitle("AIリサーチャー"));
    expect(normalizeTitle("Μηχανικός Λογισμικού (m/w/d)")).toBe("μηχανικος λογισμικου");
  });

  it("marks that belong to the letter stay: words of Devanagari, Thai and Japanese do not collide", () => {
    for (const [a, b] of [["कमल", "कमला"], ["राम", "रम"], ["กิน", "กัน"], ["ジム", "シム"], ["バイト", "ハイト"]] as const) {
      expect(normalizeTitle(a)).not.toBe(normalizeTitle(b));
      expect(companyKey(a)).not.toBe(companyKey(b));
    }
    expect(normalizeTitle("バックエンドエンジニア")).toBe("バックエンドエンジニア");
    // half-width katakana and its voicing mark compose to the full-width letter
    expect(normalizeTitle("ｴﾝｼﾞﾆｱ")).toBe("エンジニア");
    // diacritics on Greek and Cyrillic letters still fold
    expect(normalizeTitle("Μηχανικός")).toBe(normalizeTitle("Μηχανικος"));
    expect(companyKey("Ёлка")).toBe(companyKey("Елка"));
  });

  it("the gender markers and legal forms around them still go", () => {
    expect(normalizeTitle("Разработчик (m/w/d)")).toBe(normalizeTitle("Разработчик"));
    expect(companyKey("Яндекс GmbH")).toBe("яндекс");
  });

  it("a company name without letters or digits keys as itself in lower case, never as the empty key", () => {
    expect(companyKey("!!!")).toBe("!!!");
    expect(companyKey(" 🚀  Rocket ")).toBe("rocket");
    expect(companyKey(" 🚀 ✨ ")).toBe("🚀 ✨");
    expect(companyKey("")).toBe("");
    expect(resolveCompanyName("💰", config).nameNorm).toBe("💰");
  });

  it("an alias in another script resolves only its own spelling", () => {
    const withAlias = pipelineWith((raw) => {
      (raw.company as { aliases: Record<string, string[]> }).aliases = { Yandex: ["Яндекс"] };
    });
    expect(resolveCompanyName("Яндекс", withAlias).name).toBe("Yandex");
    // with key version 1 the alias keyed as "", so every name without Latin letters resolved to that company
    expect(resolveCompanyName("株式会社メルカリ", withAlias)).toEqual({ name: "株式会社メルカリ", nameNorm: "株式会社メルカリ", aliases: [] });
  });
});
