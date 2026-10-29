import { expect, it } from "vitest";
import { relistDecision } from "@/lib/jobs/relist";
import { relistCases } from "./relist-cases";

it.each(relistCases)("$name", ({ expected, ...input }) => {
  expect(relistDecision(input)).toBe(expected);
});
