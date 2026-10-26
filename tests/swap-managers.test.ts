import { describe, expect, it } from "vitest";

import { selectedSwapManagers } from "./helpers/swap-managers";

describe("worker switch manager selection", () => {
  it.each([
    { value: undefined, expected: ["systemd", "launchd"] },
    { value: "systemd", expected: ["systemd"] },
    { value: "launchd", expected: ["launchd"] },
    { value: "systemd,launchd", expected: ["systemd", "launchd"] },
    { value: " launchd, systemd,launchd ", expected: ["systemd", "launchd"] },
  ])("selects $value", ({ value, expected }) => {
    expect(selectedSwapManagers(value)).toEqual(expected);
  });

  it.each(["", " ", "bogus", "systemd,bogus", "launchd,", ",systemd"])("rejects %j", (value) => {
    expect(() => selectedSwapManagers(value)).toThrow("Invalid SWAP_MANAGERS");
  });
});
