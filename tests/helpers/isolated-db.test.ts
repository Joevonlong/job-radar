// @vitest-environment node
import { describe, expect, it } from "vitest";

import { checkedName, createIsolatedDb } from "./isolated-db";

/** The refusals of the isolated-db helper happen before any connection is made (the URLs point at nothing). */
describe("tests/helpers/isolated-db", () => {
  it("refuses port 5433 (a local installation's database) before connecting", async () => {
    await expect(createIsolatedDb("postgres://u:p@127.0.0.1:5433/postgres", "x")).rejects.toThrow(/refusing port 5433/);
  });

  it.each([["jobradar"], ["jobradar_e2e_x"], ["postgres"], ["other_jobradar_test_x"]])("refuses the name %s (no jobradar_test_ prefix)", (name) => {
    expect(() => checkedName(name)).toThrow(/must start with jobradar_test_/);
  });

  it.each([["jobradar_test_Upper"], ["jobradar_test_a-b"], [`jobradar_test_${"x".repeat(50)}`]])("refuses %s (characters or length)", (name) => {
    expect(() => checkedName(name)).toThrow(/refusing the name/);
  });

  it("accepts a well-formed name", () => {
    expect(checkedName("jobradar_test_label_123_abcdef")).toBe("jobradar_test_label_123_abcdef");
  });

  it("refuses a label that would make an invalid name, before connecting", async () => {
    await expect(createIsolatedDb("postgres://u:p@127.0.0.1:1/postgres", "Bad-Label")).rejects.toThrow(/refusing the name/);
  });
});
