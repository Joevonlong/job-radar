import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ getLocale: async () => "en", getTranslations: async () => (key: string) => key }));
import { CareerCard } from "@/components/career/career-card";
import { CareerEditor } from "@/components/career/career-editor";
import CareerPage from "@/app/career/page";
import {
  deleteCareerAction,
  diffVersionAction,
  historyAction,
  restoreVersionAction,
  saveContactAction,
  saveProfileAction,
} from "@/app/career/actions";
import * as store from "@/lib/career/store/profile";
import * as contacts from "@/lib/career/contact/store";
import { careerDir } from "@/lib/career/store/paths";
import { tempCareer, profile } from "./fixtures";

let temp: ReturnType<typeof tempCareer> | undefined;
afterEach(() => {
  if (temp && fs.existsSync(careerDir())) fs.chmodSync(careerDir(), 0o700);
  temp?.cleanup();
  temp = undefined;
  vi.restoreAllMocks();
});

it("disabled card, page and actions never read career data or take a write lock", async () => {
  temp = tempCareer({ enabled: false });
  fs.mkdirSync(careerDir(), { recursive: true });
  fs.chmodSync(careerDir(), 0o000);
  const load = vi.spyOn(store, "loadCareerProfile");
  const contact = vi.spyOn(contacts, "loadContact");
  expect(await CareerCard()).toBeNull();
  expect((await CareerPage()).props["data-testid"]).toBe("career-disabled");
  for (const action of [
    saveProfileAction,
    saveContactAction,
    historyAction,
    diffVersionAction,
    restoreVersionAction,
    deleteCareerAction,
  ])
    expect(await action({})).toEqual({ ok: false, code: "disabled" });
  expect(load).not.toHaveBeenCalled();
  expect(contact).not.toHaveBeenCalled();
  expect(fs.readdirSync(temp.profileDir)).toEqual(["career"]);
});

it("broken config disables all entry points after warm cache", async () => {
  temp = tempCareer();
  expect(await CareerCard()).not.toBeNull();
  fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "enabled: [broken");
  expect(await CareerCard()).toBeNull();
  expect((await CareerPage()).props["data-testid"]).toBe("career-disabled");
  expect(await saveProfileAction({ profile: profile(), baseHash: null })).toEqual({ ok: false, code: "disabled" });
  expect(fs.existsSync(careerDir())).toBe(false);
});

it("validates every action input and requires the second delete confirmation", async () => {
  temp = tempCareer();
  expect((await saveProfileAction({ profile: { ...profile(), email: "private" }, baseHash: null })).ok).toBe(false);
  expect((await saveContactAction({ contact: {}, baseHash: "forged" })).ok).toBe(false);
  expect((await diffVersionAction({ version: "../../contact.yaml" })).ok).toBe(false);
  expect((await restoreVersionAction({ version: "../../contact.yaml", baseHash: null })).ok).toBe(false);
  expect((await historyAction({ extra: true })).ok).toBe(false);
  expect(await deleteCareerAction({ kind: "all", confirmed: false })).toEqual({
    ok: false,
    code: "confirmation_required",
  });
  expect(fs.existsSync(careerDir())).toBe(false);
});

it("broken private data renders a machine-code error without file text", async () => {
  temp = tempCareer();
  fs.mkdirSync(careerDir(), { recursive: true });
  fs.writeFileSync(path.join(careerDir(), "profile.yaml"), "private-sentinel: [broken");
  const card = await CareerCard();
  const page = await CareerPage();
  expect(renderToStaticMarkup(card)).not.toContain("private-sentinel");
  expect(page.props.children.find((child: { type: unknown }) => child.type === CareerEditor)?.props.errors).toEqual(["profile_invalid"]);
  const result = await saveProfileAction({ profile: profile(), baseHash: null });
  expect(result).toEqual({ ok: false, code: "profile_invalid" });
});

it("shows a not-created card before the first profile write without formatting a missing time", async () => {
  temp = tempCareer();
  const markup = renderToStaticMarkup(await CareerCard());
  expect(markup).toContain("notCreated");
  expect(markup).toContain("career-card-hint");
  expect(markup).toContain('href="/career"');
  expect(markup).not.toContain("updated");
  expect(fs.existsSync(careerDir())).toBe(false);
});

it("omits the empty-profile hint once the profile has content", async () => {
  temp = tempCareer();
  vi.spyOn(store, "loadCareerProfile").mockResolvedValue({ profile: profile(), baseHash: "stored", updatedAt: null });
  const markup = renderToStaticMarkup(await CareerCard());
  expect(markup).not.toContain("career-card-hint");
  expect(markup).toContain('href="/career"');
});
