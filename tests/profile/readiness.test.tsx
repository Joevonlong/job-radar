import fs from "node:fs";
import path from "node:path";

import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProfileIncompleteBanner } from "@/components/profile/profile-incomplete-banner";
import { missingProfileFields, readProfileReadiness } from "@/lib/scoring/profile";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { makeTempConfig, type TempConfig } from "../config/helpers";

const wrap = (node: ReactNode, locale: "en" | "zh" = "zh") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="Europe/Berlin">
    {node}
  </NextIntlClientProvider>
);

describe("missingProfileFields", () => {
  it("needs a summary or skills, either one is enough", () => {
    expect(missingProfileFields({ summary: "", skills: [] })).toEqual(["summary", "skills"]);
    expect(missingProfileFields({ summary: "   ", skills: [] })).toEqual(["summary", "skills"]);
    expect(missingProfileFields({ summary: "ML engineer", skills: [] })).toEqual([]);
    expect(missingProfileFields({ summary: "", skills: [{ name: "Python", years: null }] })).toEqual([]);
  });
});

describe("readProfileReadiness", () => {
  let temp: TempConfig;
  beforeEach(() => {
    temp = makeTempConfig();
  });
  afterEach(() => temp.cleanup());

  const writeMe = (text: string) => {
    fs.mkdirSync(temp.profileDir, { recursive: true });
    fs.writeFileSync(path.join(temp.profileDir, "me.yaml"), text);
  };
  const example = () => fs.readFileSync(path.join(temp.defaultsDir, "profile.example", "me.yaml"), "utf8");

  it("counts a missing me.yaml as empty and creates nothing", () => {
    expect(readProfileReadiness()).toEqual({ usable: false, missing: ["summary", "skills"] });
    expect(fs.existsSync(path.join(temp.profileDir, "me.yaml"))).toBe(false);
  });

  it("reads the shipped placeholder as incomplete and a filled-in summary as usable", () => {
    writeMe(example());
    expect(readProfileReadiness()).toEqual({ usable: false, missing: ["summary", "skills"] });
    writeMe(example().replace('summary: ""', 'summary: "Senior ML engineer"'));
    expect(readProfileReadiness()).toEqual({ usable: true, missing: [] });
  });

  it("returns null for a file that does not parse", () => {
    writeMe("summary: [unclosed");
    expect(readProfileReadiness()).toBeNull();
  });
});

describe("ProfileIncompleteBanner", () => {
  it("names the missing fields, the waiting jobs and links to /me", () => {
    render(wrap(<ProfileIncompleteBanner missing={["summary", "skills"]} waiting={139} />));
    const banner = screen.getByTestId("profile-incomplete-banner");
    expect(banner).toHaveTextContent("画像不完整，AI 打分已暂停");
    expect(banner).toHaveTextContent("缺少：简介（summary）、技能（skills）");
    expect(banner).toHaveTextContent("139 条岗位在等 AI 打分");
    expect(screen.getByRole("link", { name: "去填写画像" })).toHaveAttribute("href", "/me");
  });

  it("speaks English and leaves the link out on /me itself", () => {
    render(wrap(<ProfileIncompleteBanner missing={["summary", "skills"]} waiting={1} showLink={false} />, "en"));
    expect(screen.getByTestId("profile-incomplete-banner")).toHaveTextContent("Profile incomplete: AI scoring is paused");
    expect(screen.getByTestId("profile-incomplete-banner")).toHaveTextContent("1 job is waiting");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows nothing for a usable profile", () => {
    render(wrap(<ProfileIncompleteBanner missing={[]} waiting={5} />));
    expect(screen.queryByTestId("profile-incomplete-banner")).toBeNull();
  });
});
