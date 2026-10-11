// @vitest-environment node
import { describe, expect, it } from "vitest";

import { detectAgency, detectContract } from "@/lib/pipeline/contract";

import { shippedPipeline } from "./helpers";

const config = shippedPipeline();
const contract = (title: string, extra: { hint?: string; description?: string; company?: string } = {}) =>
  detectContract({ title, contractHint: extra.hint, description: extra.description ?? "", companyName: extra.company ?? "Acme GmbH" }, config);

describe("contract type", () => {
  it.each(["Location: Munich\nEmployment: Full-time, permanent\nURL", "Employment Type: Full time / regular"])("labelled employment line %j is permanent", (description) => {
    expect(contract("Senior AI Engineer", { description })).toBe("permanent");
  });
  it.each(["Employment Type: Full-Time, indefinite term", "Contract: indefinite period, full-time"])("indefinite term %j is permanent", (description) => {
    expect(contract("Senior AI Engineer", { description })).toBe("permanent");
  });
  it("does not read 'regular' outside the employment type label", () => {
    expect(contract("Senior AI Engineer", { description: "Regular team events. Employment: Full-time" })).toBe("unknown");
  });

  it.each([
    "Werkstudent KI (m/w/d)",
    "Werkstudentin Data Science",
    "Praktikum im Bereich Machine Learning",
    "Praktikant AI Engineering",
    "Pflichtpraktikum Data Science",
    "Ausbildung zum Fachinformatiker",
    "Auszubildende Anwendungsentwicklung",
    "Duales Studium Informatik",
    "Master Thesis: LLM Evaluation",
    "Abschlussarbeit Computer Vision",
    "Bachelorarbeit Robotik",
    "Machine Learning Internship",
    "Data Science Intern",
  ])("%s is student", (title) => {
    expect(contract(title)).toBe("student");
  });

  it("is student from the channel's hint too", () => {
    expect(contract("AI Engineer", { hint: "Werkstudent" })).toBe("student");
  });

  it("does not read student keywords out of the description", () => {
    expect(contract("AI Engineer", { description: "We also offer a Praktikum and thesis topics." })).toBe("unknown");
    expect(contract("Internal Tools Engineer")).toBe("unknown");
  });

  it.each([
    ["AI Consultant", { description: "Einsatz im Rahmen der Arbeitnehmerüberlassung (AÜG)." }],
    ["AI Engineer (Zeitarbeit)", {}],
    ["AI Engineer", { company: "Muster Zeitarbeit GmbH" }],
  ])("%s is temp_agency", (title, extra) => {
    expect(contract(title, extra)).toBe("temp_agency");
  });

  it.each([
    ["Freelance AI Engineer", {}],
    ["ML Engineer (freiberuflich)", {}],
    ["Contractor - Data Engineer", {}],
    ["Data Engineer", { hint: "Freelance" }],
  ])("%s is freelance", (title, extra) => {
    expect(contract(title, extra)).toBe("freelance");
  });

  it("detects fixed-term and permanent from title, hint and description", () => {
    expect(contract("AI Engineer (befristet)")).toBe("fixed_term");
    expect(contract("AI Engineer", { description: "Fixed-term contract for 18 months." })).toBe("fixed_term");
    expect(contract("AI Engineer", { description: "Wir bieten eine unbefristete Festanstellung." })).toBe("permanent");
    expect(contract("AI Engineer", { hint: "Permanent position" })).toBe("permanent");
    expect(contract("AI Engineer", { description: "Eine unbefristete Stelle." })).toBe("permanent");
  });

  it("does not read 'unbefristet' as befristet", () => {
    expect(contract("AI Engineer", { description: "unbefristet" })).toBe("permanent");
  });

  it("is unknown when nothing is said (C3), and full-time is not a contract type", () => {
    expect(contract("AI Engineer", { hint: "Vollzeit" })).toBe("unknown");
  });

  it("ranks student above temp agency above freelance", () => {
    expect(contract("Werkstudent (Zeitarbeit)")).toBe("student");
    expect(contract("Freelance Engineer", { description: "Arbeitnehmerüberlassung" })).toBe("temp_agency");
  });
});

describe("agency detection", () => {
  const agency = (companyName: string, over: { title?: string; description?: string; flagged?: boolean } = {}) =>
    detectAgency({ title: over.title ?? "AI Engineer", description: over.description ?? "", companyName, flagged: over.flagged }, config, "unknown");

  it("trusts the channel's flag", () => {
    expect(agency("Acme GmbH", { flagged: true })).toBe(true);
    expect(agency("Acme GmbH", { flagged: false })).toBe(false);
  });

  it("knows agencies by name table and by name patterns", () => {
    expect(agency("Hays AG")).toBe(true);
    expect(agency("Michael Page")).toBe(true);
    expect(agency("Müller Personalberatung GmbH")).toBe(true);
    expect(agency("Tech Recruiting Partners")).toBe(true);
    expect(agency("Northwind Labs GmbH")).toBe(false);
  });

  it("knows 'on behalf of our client' wording", () => {
    expect(agency("Anon", { description: "Für unseren Kunden suchen wir einen ML Engineer." })).toBe(true);
    expect(agency("Anon", { description: "We are recruiting on behalf of a leading fintech." })).toBe(true);
    expect(agency("Anon", { description: "Our client is a leading fintech." })).toBe(true);
  });

  it("treats a temp-agency contract as an agency", () => {
    expect(detectAgency({ title: "x", description: "", companyName: "Acme", flagged: undefined }, config, "temp_agency")).toBe(true);
  });

  it("is driven by the config lists", () => {
    const custom = { ...config, company: { ...config.company, agency_names: ["Acme"] } };
    expect(detectAgency({ title: "x", description: "", companyName: "Acme Inc.", flagged: undefined }, custom, "unknown")).toBe(true);
  });
});

describe("agency / recruiter detection", () => {
  const agency = (description: string, company = "Northwind Labs GmbH", title = "AI Engineer") => detectAgency({ title, description, companyName: company, flagged: undefined }, config, "unknown");

  it.each([
    "This is a job that Jill, our AI Recruiter, is recruiting for on behalf of one of our customers.",
    "We are recruiting on behalf of our client, a Series B AI company.",
    "Our client, a leading insurer in Munich, is looking for a data scientist.",
    "AI Futures has been exclusively retained to identify a Forward Deployed Engineer for a well-funded startup.",
    "I'm hiring a Senior Machine Learning Engineer to join a fast-scaling German defence technology company.",
    "We're supporting a growing AI & Data Science company in Darmstadt that partners with customers across industries.",
    "Im Auftrag unseres Kunden suchen wir einen KI-Experten.",
    "Für unseren Mandanten suchen wir einen Data Scientist.",
    "Wir suchen für einen unserer Kunden einen Entwickler.",
    "We are a specialist recruitment agency for AI roles.",
    "Unser Kunde ist ein etabliertes internationales Technologieunternehmen.",
    "Als Personalberatung begleiten wir Sie auf Ihrem Weg.",
  ])("flags: %s", (text) => {
    expect(agency(text)).toBe(true);
  });

  it.each(["Jack & Jill", "Acceler8 Talent", "Findr", "AI Futures", "Findr Ltd."])("flags the agency %s by name", (name) => {
    expect(agency("Build things.", name)).toBe(true);
  });

  it("does not flag an ordinary employer posting", () => {
    expect(agency("We build logistics software. Our customers are retailers. Join our team of engineers.")).toBe(false);
    expect(agency("Wir entwickeln Software für unsere Kunden und arbeiten eng im Team.")).toBe(false);
    expect(agency("Mit unserem Wissen schaffen wir Wert für unsere Mandant:innen und die Gesellschaft.", "EY")).toBe(false);
  });

  it("does not flag an employer that turns recruiters away", () => {
    expect(agency("We will not accept unsolicited resumes from any source (e.g. recruitment agency) other than directly from a candidate.")).toBe(false);
    expect(agency("We do not accept unsolicited assistance from any headhunters or recruitment firms for any of our job openings.")).toBe(false);
    expect(agency("Keine unaufgeforderten Zusendungen von Personalberatungen bitte.")).toBe(false);
  });
});

describe("contract wording and agency names", () => {
  it.each([
    ["Employment: Full-time", "unknown"],
    ["Employment Type: Permanent", "permanent"],
    ["⏱️ Art der Anstellung: Vollzeit", "unknown"],
    ["Art der Anstellung: Festanstellung", "permanent"],
    ["Permanent full-time contract", "permanent"],
    ["Vollzeit · Unbefristet", "permanent"],
    ["We offer an open-ended contract.", "permanent"],
    ["Wir bieten eine unbefristete Stelle.", "permanent"],
    ["Employment: Fixed-term", "fixed_term"],
    ["Vollzeit, befristet auf 2 Jahre", "fixed_term"],
    ["Mutterschaftsvertretung für 12 Monate", "fixed_term"],
    ["27 days of holiday for full-time employees", "unknown"],
    ["You don't need to be a full-time engineer", "unknown"],
    ["equal employment opportunity employer", "unknown"],
  ])("%s -> %s", (description, expected) => {
    expect(contract("AI Engineer", { description })).toBe(expected);
  });

  it.each(["Haystack", "Rocken®", "Instaffo GmbH", "Optimus Search"])("%s is a known agency", (company) => {
    expect(detectAgency({ title: "x", description: "", companyName: company, flagged: undefined }, config, "unknown")).toBe(true);
  });

  it.each([
    "We're hiring on behalf of a Haystack partner!",
    "Im Kundenauftrag suchen wir einen SPS-Programmierer.",
  ])("recognises the wording %s", (description) => {
    expect(detectAgency({ title: "x", description, companyName: "Northwind Labs", flagged: undefined }, config, "unknown")).toBe(true);
  });
});

describe("recruiter direct hire is not temp agency work", () => {
  const amadeus =
    "Amadeus Fire – Ihr spezialisierter Personaldienstleister.\nVertragsart: Personalvermittlung, (40 Stunden/Woche)\nUnbefristete Anstellung\nGehaltsrahmen: 75.000 bis 85.000 EUR/Jahr";

  it("keeps a Personalvermittlung posting by a Personaldienstleister as permanent and tags it as agency", () => {
    const kind = contract("Senior Robotics Software Engineer", { description: amadeus, company: "Amadeus Fire AG" });
    expect(kind).toBe("permanent");
    expect(detectAgency({ title: "Senior Robotics Software Engineer", description: amadeus, companyName: "Amadeus Fire AG", flagged: undefined }, config, kind)).toBe(true);
  });

  it("reads the real LinkedIn list shape (Amadeus Fire #380): no contract stated, so unknown rather than temp_agency", () => {
    const description =
      "Weitere Details\n\n- Vertragsart: Personalvermittlung, (40 Stunden/Woche)\n- Branche: Automotive\n\nDie Amadeus Fire AG ist Ihr spezialisierter Personaldienstleister im kaufmännischen und IT-Bereich.";
    const kind = contract("AI Software Engineer (m/w/d)", { hint: "Full-time", description, company: "Amadeus Fire" });
    expect(kind).toBe("unknown");
    expect(detectAgency({ title: "AI Software Engineer (m/w/d)", description, companyName: "Amadeus Fire", flagged: undefined }, config, kind)).toBe(true);
  });

  it("does not read the word Personaldienstleister as temp agency work", () => {
    expect(contract("AI Consultant", { description: "Wir sind ein Personaldienstleister." })).toBe("unknown");
    expect(detectAgency({ title: "AI Consultant", description: "Wir sind ein Personaldienstleister.", companyName: "Northwind", flagged: undefined }, config, "unknown")).toBe(true);
  });

  it.each([
    "Unser Portfolio: Zeitarbeit und Personalvermittlung.\nVertragsart: Personalvermittlung",
    "Wir bieten Zeitarbeit an. Diese Stelle ist eine Direktvermittlung.",
    "Zeitarbeit ist unser Kerngeschäft; diese Position besetzen wir im Rahmen der Personalvermittlung.",
    "Zeitarbeit und mehr. Direkte Festanstellung bei unserem Kunden.",
  ])("a stated direct hire wins over Zeitarbeit boilerplate: %s", (description) => {
    expect(contract("AI Engineer", { description })).not.toBe("temp_agency");
  });

  it.each([
    "Einsatz im Rahmen der Arbeitnehmerüberlassung (AÜG). Wir sind auch in der Personalvermittlung tätig.",
    "Vertragsart: Arbeitnehmerüberlassung",
    "Zeitarbeit mit Übernahmeoption durch den Kunden.",
  ])("real Arbeitnehmerüberlassung / Zeitarbeit stays temp_agency: %s", (description) => {
    expect(contract("AI Engineer", { description })).toBe("temp_agency");
  });

  it("does not flag an employer that turns Personaldienstleister away", () => {
    expect(detectAgency({ title: "x", description: "Bitte keine Bewerbungen über Personaldienstleister.", companyName: "Northwind", flagged: undefined }, config, "unknown")).toBe(false);
  });
});
