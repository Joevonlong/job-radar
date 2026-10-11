// @vitest-environment node
import { describe, expect, it } from "vitest";

import { normalizeDraft } from "@/lib/pipeline";
import { extractWorkplace } from "@/lib/pipeline/workplace";

import { draft, shippedPipeline } from "./helpers";

const config = shippedPipeline();
const read = (description: string, extra: { title?: string; locations?: string[]; hint?: string } = {}) =>
  extractWorkplace({ title: extra.title ?? "AI Engineer", locationLabels: extra.locations ?? ["Berlin, Germany"], contractHint: extra.hint, description }, config);

describe("work mode from the posting's own words", () => {
  it.each([
    ["Hybrid work model: 3 days in the office, 2 days from home.", "hybrid"],
    ["Location: Berlin - On-site", "onsite"],
    ["📍 Deutschlandweit (Hybrid) | 🕓 Vollzeit | 🌍 Unbefristet", "hybrid"],
    ["Ob im Berliner Office oder remote (in DE) arbeitest du flexibel.", "hybrid"],
    ["Bürotage von Montag bis Mittwoch, Donnerstag und Freitag mobil arbeiten", "hybrid"],
    ["Flexible Arbeitszeiten, bis zu 49 % Mobilarbeit", "hybrid"],
    ["Mobile Work-Modelle / Home-Office Optionen", "hybrid"],
    ["Happy to work on-site with the team in Berlin.", "onsite"],
    ["Office-First-Kultur: Unser Office in Berlin Mitte ist das Herz.", "onsite"],
    ["Hybrid work model: we are an office-first company, but flexible.", "hybrid"],
    ["We offer a flexible hybrid working model.", "hybrid"],
    ["Join them on a hybrid basis in Berlin.", "hybrid"],
    ["Hybrides Arbeiten: Mindestens zweimal die Woche kommen wir in unserem Büro zusammen.", "hybrid"],
    ["Hybrid (2 Tage Homeoffice / Woche)", "hybrid"],
    ["Hybride Arbeitsweise (3 Tage Office/Woche)", "hybrid"],
    ["Working Model : Hybrid", "hybrid"],
    ["Workplace type: Hybrid Working", "hybrid"],
    ["Home Office möglich", "hybrid"],
    ["Mobiles Arbeiten ist bis zu 50 Prozent möglich.", "hybrid"],
    ["You can work up to three days of working from home per week.", "hybrid"],
    ["Remote or hybrid work model: 2 days/week at our campus.", "hybrid"],
    ["#LI-Hybrid", "hybrid"],
    ["This is a 100% remote role.", "remote"],
    ["We are a remote-first company.", "remote"],
    ["Fully remote position within the EU.", "remote"],
    ["Vollständig remote möglich.", "remote"],
    ["#LI-Remote", "remote"],
    ["Location: Berlin (Onsite) Employment: Full-time", "onsite"],
    ["Workplace type: On-site", "onsite"],
    ["#LI-Onsite", "onsite"],
    ["Das ist eine Präsenzstelle.", "onsite"],
  ])("%s -> %s", (description, expected) => {
    expect(read(description)).toBe(expected);
  });

  it("reads the title, the location texts and the contract hint too", () => {
    expect(read("Build things.", { title: "Senior AI Engineer (Remote)" })).toBe("remote");
    expect(read("Build things.", { title: "Data Scientist – €100,000 – Hybrid – Munich" })).toBe("hybrid");
    expect(read("Build things.", { locations: ["Remote, Germany"] })).toBe("remote");
    expect(read("Build things.", { locations: ["On-Site - Madrid"] })).toBe("onsite");
    expect(read("Build things.", { locations: ["Home Office, DE"] })).toBe("remote");
  });

  it("says nothing it does not read: unknown (C3)", () => {
    expect(read("Build LLM-powered features for our logistics platform.")).toBe("unknown");
    expect(read("")).toBe("unknown");
  });

  it("does not take a benefit, a side remark or another meaning of the word for the work mode", () => {
    expect(read("Remote Working Furniture: you receive a monthly allowance.")).toBe("unknown");
    expect(read("Family support: 5 days of paid emergency leave, 100% remote work option during pregnancy.")).toBe("unknown");
    expect(read("Apple equipment plus home office stipend.")).toBe("unknown");
    expect(read("Spend up to 2 months a year working outside your country with our Work from Anywhere policy.")).toBe("unknown");
    expect(read("We need a hybrid professional who thrives at the intersection of business and tech.")).toBe("unknown");
    expect(read("Experience with on-premise and hybrid deployment models.")).toBe("unknown");
    expect(read("Case Study vor Ort, then a final interview.")).toBe("unknown");
    expect(read("Interviews are held remotely.")).toBe("unknown");
  });

  it("ignores a mode that a negation takes back", () => {
    expect(read("Location: Gdańsk. This role is not available as fully remote.")).toBe("unknown");
    expect(read("We value in-person collaboration; we do not offer remote-only roles.")).toBe("unknown");
  });

  it("stays unknown when the text names two different modes", () => {
    expect(read("Fully remote position. Hybrides Arbeiten vom Büro und aus dem Home-Office ist Teil unserer Kultur.")).toBe("unknown");
    expect(read("This is a 100% remote role. #LI-Hybrid")).toBe("unknown");
    expect(read("Build things.", { title: "Engineer (Remote / On-site)" })).toBe("unknown");
  });

  it("lets the title, location and hint decide before the description", () => {
    expect(read("Hybrid work model with 3 days in the office.", { title: "Engineer (Remote)" })).toBe("remote");
  });

  it("uses the lists of the config", () => {
    const custom = { ...config, workplace: { ...config.workplace, text: { ...config.workplace.text, remote: ["telearbeit"], hybrid: [], onsite: [] } } };
    expect(extractWorkplace({ title: "x", locationLabels: [], description: "Telearbeit ist die Regel." }, custom)).toBe("remote");
    expect(extractWorkplace({ title: "x", locationLabels: [], description: "Hybrid work model." }, custom)).toBe("unknown");
  });
});

describe("normalizeDraft and the work mode", () => {
  it("keeps what the source states and only fills in `unknown`", () => {
    const text = "This is a 100% remote role.";
    expect(normalizeDraft(draft({ workplace: "onsite", description: text }), config).workplace).toBe("onsite");
    expect(normalizeDraft(draft({ workplace: "unknown", description: text }), config).workplace).toBe("remote");
    expect(normalizeDraft(draft({ workplace: "unknown", description: "Build things." }), config).workplace).toBe("unknown");
  });

  it("reads the location texts of the draft", () => {
    const job = normalizeDraft(draft({ workplace: "unknown", description: "Build things.", locations: [{ label: "Berlin (Onsite)", city: "Berlin", countryCode: "DE" }] }), config);
    expect(job.workplace).toBe("onsite");
  });
});

describe("a generic channel `remote` label and the JD", () => {
  it("lets a JD that says hybrid or on-site win over the channel's remote label", () => {
    expect(normalizeDraft(draft({ workplace: "remote", description: "We offer a hybrid working model in Berlin." }), config).workplace).toBe("hybrid");
    expect(normalizeDraft(draft({ workplace: "remote", description: "One team day per week plus another day in the office of your choice." }), config).workplace).toBe("hybrid");
  });

  it("keeps remote when the JD says nothing, says remote, or mixes modes", () => {
    expect(normalizeDraft(draft({ workplace: "remote", description: "Build things." }), config).workplace).toBe("remote");
    expect(normalizeDraft(draft({ workplace: "remote", description: "This is a 100% remote role." }), config).workplace).toBe("remote");
    expect(normalizeDraft(draft({ workplace: "remote", description: "Hybrid work model, or a fully remote role for senior hires." }), config).workplace).toBe("remote");
  });
});
