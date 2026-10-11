// @vitest-environment node
import { describe, expect, it } from "vitest";

import { detectLanguage, extractGermanLevel } from "@/lib/pipeline/language";

import { shippedPipeline } from "./helpers";

const config = shippedPipeline();

const EN =
  "We are looking for a machine learning engineer to join our team. You will work with the data science group and build models that are used by our customers. We offer a flexible working environment and you will have the opportunity to learn from experienced colleagues.";
const DE =
  "Wir suchen einen Machine Learning Engineer für unser Team. Du arbeitest mit der Data Science Gruppe zusammen und entwickelst Modelle, die von unseren Kunden genutzt werden. Wir bieten dir ein flexibles Arbeitsumfeld und die Möglichkeit, von erfahrenen Kollegen zu lernen.";
const FR =
  "Nous recherchons un ingénieur en apprentissage automatique pour rejoindre notre équipe. Vous travaillerez avec le groupe de science des données et vous construirez des modèles utilisés par nos clients. Nous offrons un environnement de travail flexible et la possibilité d'apprendre de collègues expérimentés.";

describe("description language", () => {
  it("detects English and German", () => {
    expect(detectLanguage(EN, config)).toBe("en");
    expect(detectLanguage(DE, config)).toBe("de");
  });

  it("calls anything else `other`", () => {
    expect(detectLanguage(FR, config)).toBe("other");
  });

  it("takes the channel's hint only for short texts, else unknown", () => {
    expect(detectLanguage("Kurzer Text", config, "de")).toBe("de");
    expect(detectLanguage("Short text", config, "en")).toBe("en");
    expect(detectLanguage("Texte court", config, "fr")).toBe("other");
    expect(detectLanguage("Short text", config)).toBe("unknown");
    expect(detectLanguage("", config, "unknown")).toBe("unknown");
    // a long text is judged by its words, not by a wrong hint
    expect(detectLanguage(EN, config, "de")).toBe("en");
  });
});

describe("German level rules", () => {
  it.each([
    ["Fließende Deutschkenntnisse erforderlich", "C1"],
    ["Verhandlungssichere Deutsch- und Englischkenntnisse", "C1"],
    ["Fluent German required", "C1"],
    ["Business fluent German and English", "C1"],
    ["Sehr gute Deutschkenntnisse", "C1"],
    ["Gute Deutschkenntnisse", "B2"],
    ["Good command of German", "B2"],
    ["Fluent English and good German", "B2"],
    ["Grundkenntnisse in Deutsch", "A2"],
    ["Basic German skills", "A2"],
    ["Conversational German", "B1"],
    ["Native German speaker", "C2"],
    ["Muttersprache Deutsch", "C2"],
    ["Deutsch als Muttersprache", "C2"],
  ])("%s -> %s", (text, level) => {
    expect(extractGermanLevel(text, config)).toBe(level);
  });

  it.each([
    ["German (C1)", "C1"],
    ["German C1 required", "C1"],
    ["Deutsch B2", "B2"],
    ["Deutschkenntnisse (B2)", "B2"],
    ["Deutschkenntnisse auf B2-Niveau", "B2"],
    ["German at C1 level", "C1"],
    ["German language skills: B1", "B1"],
    ["C1 German", "C1"],
    ["B2-level German", "B2"],
    ["Deutsch mindestens B1", "B1"],
    ["English C1 and German B2", "B2"],
    ["German (a1)", "A1"],
  ])("explicit level: %s -> %s", (text, level) => {
    expect(extractGermanLevel(text, config)).toBe(level);
  });

  it.each([
    "German is a plus",
    "Deutschkenntnisse von Vorteil",
    "German is nice to have",
    "Deutschkenntnisse sind wünschenswert",
    "German B2 is a plus",
    "Preferred: Fluent in German",
    "Fluent German preferred",
    "Fließende Deutschkenntnisse sind ein Pluspunkt",
    "Ideally you speak German (C1)",
  ])("%s -> preferred (never a requirement)", (text) => {
    expect(extractGermanLevel(text, config)).toBe("preferred");
  });

  it.each([
    "No German required",
    "Keine Deutschkenntnisse erforderlich",
    "German is not required",
    "Deutschkenntnisse sind nicht erforderlich",
  ])("%s -> none", (text) => {
    expect(extractGermanLevel(text, config)).toBe("none");
  });

  it("reads \"preferred\" under a Preferred Qualifications heading even without punctuation (Quantexa)", () => {
    const quantexa =
      "Minimum Experience And Qualifications Significant experience in a commercially focused, technical role such as Solution Engineering Ability to travel as needed. Preferred Qualifications Fluent in German and English Preferred German Citizen for potential security clearances Depending on the job, there may be additional minimum requirements and/or preferred qualifications.";
    expect(extractGermanLevel(quantexa, config)).toBe("preferred");
  });

  it("reads the marker that closes a list of languages as belonging to German (Airbus)", () => {
    expect(extractGermanLevel("Language Skills: English: Business fluent German, Spanish, French or Italian are a plus", config)).toBe("preferred");
    expect(extractGermanLevel("Languages: English fluent, German, French or Italian are a plus.", config)).toBe("preferred");
    // a plus for another language does not make German optional
    expect(extractGermanLevel("Fluent German required, English is a plus", config)).toBe("C1");
  });

  it("does not take the next section's Preferred heading for a marker on the German mentioned just before it (AWS)", () => {
    expect(extractGermanLevel("Fluent written and verbal communication skills in English and German Preferred Qualifications Experience with AWS", config)).toBe("unknown");
  });

  it("does not count German citizenship or a German company as the language", () => {
    expect(extractGermanLevel("Preferred German Citizen for potential security clearances", config)).toBe("unknown");
    expect(extractGermanLevel("Join a fast-scaling German defence technology company. Fluent English required.", config)).toBe("unknown");
    expect(extractGermanLevel("Good knowledge of German law is helpful", config)).toBe("unknown");
  });

  it("keeps a requirement that stands in the same sentence as a preferred heading's list, and ends a preferred part at the next heading", () => {
    expect(extractGermanLevel("Nice to have: Kubernetes. Fluent German required.", config)).toBe("C1");
    expect(extractGermanLevel("Preferred Qualifications: Kubernetes\nRequirements: Fluent German", config)).toBe("C1");
  });

  it("reads a requirement far away from a \"plus\" in a text without punctuation (long gap)", () => {
    const bwi =
      "Dein Profil Absolviertes Studium Mind. 3 Jahre Rust-Erfahrung Kenntnisse und Verständnis mit der Entwicklung von Client-SDKs wie uniffi-rs oder Tauri ist ein Plus (Client-SDK) Kenntnisse von kubernetes-basierten Applikations-Architekturen ist ein Plus (Backend) Kreativer und flexibler Kopf mit intrinsischer Motivation zur Umsetzung eigener Ideen und einer ausgeprägten Hands-On-Mentalität Verhandlungssicheres Deutsch in Wort und Schrift sowie sehr gute Englischkenntnisse Wir bieten 30 Tage Jahresurlaub";
    expect(extractGermanLevel(bwi, config)).toBe("C1");
    expect(extractGermanLevel("Verhandlungssicheres Deutsch in Wort und Schrift", config)).toBe("C1");
    expect(extractGermanLevel("Fließend Deutsch (C1) und Englisch", config)).toBe("C1");
  });

  it("is unknown when German is not mentioned or has no level (C3)", () => {
    expect(extractGermanLevel(EN, config)).toBe("unknown");
    expect(extractGermanLevel("Fluent English required", config)).toBe("unknown");
    expect(extractGermanLevel("German required", config)).toBe("unknown");
    expect(extractGermanLevel("", config)).toBe("unknown");
  });

  it("does not mistake Germany, Deutschland or Deutsche Bank for the language", () => {
    expect(extractGermanLevel("Fluent in our Deutschland offices", config)).toBe("unknown");
    expect(extractGermanLevel("We work for Deutsche Bank, a good employer", config)).toBe("unknown");
    expect(extractGermanLevel("Based in Germany, fluent English", config)).toBe("unknown");
  });

  it("takes the highest required level across the posting; a plus does not lower it", () => {
    expect(extractGermanLevel("German B1 required.\nFluent German is a plus for the lead role. Gute Deutschkenntnisse (B2).", config)).toBe("B2");
    expect(extractGermanLevel("Fluent English. German is a plus.", config)).toBe("preferred");
    expect(extractGermanLevel("No German required. German is a plus.", config)).toBe("preferred");
    expect(extractGermanLevel("German is a plus. Deutsch C1 erforderlich.", config)).toBe("C1");
  });

  it("uses the rules of the config", () => {
    const custom = {
      ...config,
      language: { ...config.language, requirement: { ...(config.language.requirement as NonNullable<typeof config.language.requirement>), level_rules: [{ pattern: "zweisprachig", level: "C2" as const }] } },
    };
    expect(extractGermanLevel("Zweisprachig Deutsch", custom)).toBe("C2");
    expect(extractGermanLevel("Fließende Deutschkenntnisse", custom)).toBe("unknown");
  });
});

describe("sufficient level after a plus", () => {
  it("takes the level that is enough as the requirement (getpress)", () => {
    expect(extractGermanLevel("- C1-Deutschkenntnisse sind von Vorteil, B2-Niveau ist ausreichend (mit Motivation, den Kurs zu C1 zu machen)", config)).toBe("B2");
    expect(extractGermanLevel("German C1 is a plus, B2 is sufficient.", config)).toBe("B2");
  });

  it("still treats a plain plus as preferred", () => {
    expect(extractGermanLevel("C1-Deutschkenntnisse sind von Vorteil, Englisch ist ausreichend.", config)).toBe("preferred");
    expect(extractGermanLevel("German is a plus.", config)).toBe("preferred");
  });
});
