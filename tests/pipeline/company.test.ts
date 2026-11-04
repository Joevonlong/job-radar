// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildStoredAliasIndex, isAgencyCompany, normalizeCompanyKey, resolveCompanyName } from "@/lib/pipeline/company";

import { pipelineWith, shippedPipeline } from "./helpers";

const config = shippedPipeline();
const key = (name: string) => normalizeCompanyKey(name, config.company.legal_suffixes);

describe("company name normalization (ported from the legacy company-resolution tests)", () => {
  it("normalizes harmless legal suffix and punctuation differences", () => {
    expect(key("Signal Works GmbH")).toBe("signal-works");
    expect(key("SIGNAL Works, G.m.b.H.")).toBe("signal-works");
  });

  it("does not collapse parent, subsidiary, or brand names heuristically", () => {
    expect(key("Signal Works Labs")).not.toBe(key("Signal Works"));
    expect(key("Acme AI")).not.toBe(key("Acme"));
  });
});

describe("legal suffixes", () => {
  it.each([
    ["Northwind Labs GmbH", "northwind-labs"],
    ["Fabrikam Software AG", "fabrikam-software"],
    ["Modehaus SE", "modehaus"],
    ["Acme Inc.", "acme"],
    ["Acme, Inc", "acme"],
    ["Contoso Ltd", "contoso"],
    ["Contoso Limited", "contoso"],
    ["Beispiel GmbH & Co. KG", "beispiel"],
    ["Beispiel GmbH & Co KG", "beispiel"],
    ["Müller & Söhne UG (haftungsbeschränkt)", "muller-and-sohne-ug-haftungsbeschrankt"],
    ["Société Générale S.A.", "societe-generale"],
    ["Initech LLC", "initech"],
  ])("%s -> %s", (name, expected) => {
    expect(key(name)).toBe(expected);
  });

  it("keeps a name that is only a suffix word", () => {
    expect(key("AG")).toBe("ag");
    expect(key("SE")).toBe("se");
  });

  it("uses the suffix list of the config", () => {
    expect(normalizeCompanyKey("Acme Holdings", ["holdings"])).toBe("acme");
    expect(normalizeCompanyKey("Acme GmbH", ["holdings"])).toBe("acme-gmbh");
  });
});

describe("company aliases", () => {
  it("resolves configured spellings to the canonical company", () => {
    expect(resolveCompanyName("Alphabet Inc.", config)).toEqual({
      name: "Google",
      nameNorm: "google",
      aliases: ["Alphabet", "Google Germany", "Google Deutschland"],
    });
    expect(resolveCompanyName("Google Deutschland GmbH", config).nameNorm).toBe("google");
  });

  it("leaves other companies alone and keeps the spelling for display", () => {
    expect(resolveCompanyName("  Northwind   Labs GmbH ", config)).toEqual({ name: "Northwind Labs GmbH", nameNorm: "northwind-labs", aliases: [] });
  });

  it("uses the aliases of the config", () => {
    const custom = pipelineWith((raw) => {
      (raw.company as { aliases: Record<string, string[]> }).aliases = { Contoso: ["Contoso Cloud"] };
    });
    expect(resolveCompanyName("Contoso Cloud Ltd", custom).nameNorm).toBe("contoso");
    expect(resolveCompanyName("Alphabet", custom).nameNorm).toBe("alphabet");
  });
});

describe("agency companies", () => {
  it("matches the name table ignoring legal forms, and the name patterns", () => {
    expect(isAgencyCompany("Randstad Deutschland GmbH", config)).toBe(true);
    expect(isAgencyCompany("Robert Half", config)).toBe(true);
    expect(isAgencyCompany("Acme Personalvermittlung", config)).toBe(true);
    expect(isAgencyCompany("Northwind Labs GmbH", config)).toBe(false);
  });
});

describe("buildStoredAliasIndex", () => {
  const suffixes = ["gmbh"];

  it("keys only the stored aliases and normalizes them", () => {
    const { targets, ambiguous } = buildStoredAliasIndex([{ id: 1, aliases: ["Alephalpha GmbH", "Aleph-Alpha"] }, { id: 2, aliases: [] }], suffixes);
    expect([...targets]).toEqual([["alephalpha", 1], ["aleph-alpha", 1]]);
    expect(ambiguous).toEqual([]);
  });

  it("drops empty keys", () => {
    expect([...buildStoredAliasIndex([{ id: 1, aliases: ["", "   "] }], suffixes).targets]).toEqual([]);
  });

  it("gives one company's repeated key to it, and a key two companies give to neither", () => {
    const { targets, ambiguous } = buildStoredAliasIndex([{ id: 1, aliases: ["Acme", "ACME GmbH"] }, { id: 2, aliases: ["Other", "Shared"] }, { id: 3, aliases: ["shared gmbh"] }], suffixes);
    expect([...targets]).toEqual([["acme", 1], ["other", 2]]);
    expect(ambiguous).toEqual([{ key: "shared", companyIds: [2, 3] }]);
  });
});
