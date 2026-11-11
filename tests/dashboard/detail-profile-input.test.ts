// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ unreadable: false }));
vi.mock("@/lib/config", () => ({ loadConfig: () => { if (state.unreadable) throw new Error("unreadable profile"); return { skills: [{ name: "python 3", years: 2 }], years_experience: 4 }; } }));
vi.mock("@/lib/market", () => ({ loadPipeline: () => ({ skills: [{ name: "Python", aliases: ["python 3"] }] }) }));
import { loadDetailProfileInput } from "@/lib/jobs/detail-inputs";
afterEach(() => { state.unreadable = false; });
it("assembles profile names, years and canonical aliases for both detail views", () => {
  const input = loadDetailProfileInput();
  expect(input.profileSkills).toEqual(["python 3"]);
  expect(input.profileYears).toBe(4);
  expect(input.aliases.get("python3")).toBe("python");
});
it("an unreadable profile supplies unset matching inputs instead of guesses", () => {
  state.unreadable = true;
  const input = loadDetailProfileInput();
  expect(input.profileSkills).toEqual([]);
  expect(input.profileYears).toBeNull();
  expect(input.aliases.get("python3")).toBe("python");
});
