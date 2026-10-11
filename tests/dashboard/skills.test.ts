// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildSkillAliasMap, matchSkills, profileSkillKeys, skillKey, splitProfileSkill } from "@/lib/dashboard/skills";

const aliases = buildSkillAliasMap([
  { name: "Kubernetes", aliases: ["k8s"] },
  { name: "LLMs", aliases: ["Large Language Models", "GenAI"] },
  { name: "Vector databases", aliases: ["Vector DB"] },
  { name: "Hugging Face", aliases: ["HuggingFace"] },
  { name: "Python" },
]);

describe("skillKey", () => {
  it("ignores case, spaces, hyphens, accents and a plural s", () => {
    expect(skillKey("Hugging Face")).toBe(skillKey("huggingface"));
    expect(skillKey("LLMs")).toBe(skillKey("llm"));
    expect(skillKey("Scikit-Learn")).toBe(skillKey("scikit learn"));
    expect(skillKey("Düsseldorf")).toBe(skillKey("dusseldorf"));
  });
  it("keeps C, C++ and C# apart and does not strip the s of short names", () => {
    expect(new Set([skillKey("C"), skillKey("C++"), skillKey("C#")]).size).toBe(3);
    expect(skillKey("AWS")).toBe("aws");
  });
});

describe("matchSkills", () => {
  const me = profileSkillKeys(["python", "K8S", "large language models"], aliases);

  it("matches case-insensitively and through the pipeline.yaml aliases", () => {
    const result = matchSkills(["Python", "Kubernetes", "LLMs", "AWS", "Vector databases"], me, aliases);
    expect(result).toEqual([
      { name: "Python", have: true },
      { name: "Kubernetes", have: true },
      { name: "LLMs", have: true },
      { name: "AWS", have: false },
      { name: "Vector databases", have: false },
    ]);
  });

  it("matches an alias on the job side too and counts a skill once", () => {
    const profile = profileSkillKeys(["Vector DB"], aliases);
    expect(matchSkills(["Vector databases", "vector db"], profile, aliases)).toEqual([{ name: "Vector databases", have: true }]);
  });

  it("gives an empty list for a job without skills: not 0/0", () => {
    expect(matchSkills([], me, aliases)).toEqual([]);
  });

  it("marks every skill as missing when the profile names none", () => {
    expect(matchSkills(["Python"], profileSkillKeys([], aliases), aliases)).toEqual([{ name: "Python", have: false }]);
  });

  it("works without an alias table: only the same name matches", () => {
    const profile = profileSkillKeys(["k8s"]);
    expect(matchSkills(["Kubernetes"], profile)).toEqual([{ name: "Kubernetes", have: false }]);
  });
});

describe("one profile entry that lists several skills", () => {
  it("splits at spaced slashes, commas, semicolons, ampersands and brackets, and keeps the whole entry as one more spelling", () => {
    expect(splitProfileSkill("LLM / RAG")).toEqual(["LLM / RAG", "LLM", "RAG"]);
    expect(splitProfileSkill("Docker, Compose; Helm")).toEqual(["Docker, Compose; Helm", "Docker", "Compose", "Helm"]);
    expect(splitProfileSkill("Kubernetes (k8s)")).toEqual(["Kubernetes (k8s)", "Kubernetes", "k8s"]);
    expect(splitProfileSkill("Search & Ranking")).toEqual(["Search & Ranking", "Search", "Ranking"]);
  });

  it("does not split a name that only contains a slash or plus: CI/CD, TCP/IP, C++", () => {
    expect(splitProfileSkill("CI/CD")).toEqual(["CI/CD"]);
    expect(splitProfileSkill("C++")).toEqual(["C++"]);
    expect(splitProfileSkill("  ")).toEqual([]);
  });

  it("matches the job's 'LLMs' and 'RAG' from a profile that writes 'LLM / RAG'", () => {
    const me = profileSkillKeys(["LLM / RAG", "Python"], aliases);
    expect(matchSkills(["LLMs", "RAG", "Python", "AWS"], me, aliases)).toEqual([
      { name: "LLMs", have: true },
      { name: "RAG", have: true },
      { name: "Python", have: true },
      { name: "AWS", have: false },
    ]);
  });

  it("finds an alias inside brackets and a job that writes the whole entry", () => {
    expect(matchSkills(["Kubernetes"], profileSkillKeys(["Containers (k8s)"], aliases), aliases)).toEqual([{ name: "Kubernetes", have: true }]);
    expect(matchSkills(["CI / CD"], profileSkillKeys(["CI/CD"], aliases), aliases)).toEqual([{ name: "CI / CD", have: true }]);
  });
});
