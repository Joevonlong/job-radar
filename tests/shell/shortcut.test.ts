import { describe, expect, it } from "vitest";

import { modifierFor, resolveKeyLabel } from "@/lib/shell/shortcut";

describe("platform-aware shortcut labels", () => {
  it("is the command key on Apple platforms and Ctrl everywhere else", () => {
    for (const platform of ["MacIntel", "macOS", "iPhone", "iPad"]) expect(modifierFor(platform)).toBe("⌘");
    for (const platform of ["Win32", "Windows", "Linux x86_64", "", null, undefined]) expect(modifierFor(platform)).toBe("Ctrl");
  });

  it("swaps the Mod token and leaves other keys alone", () => {
    expect(resolveKeyLabel("Mod", "⌘")).toBe("⌘");
    expect(resolveKeyLabel("Mod", "Ctrl")).toBe("Ctrl");
    expect(resolveKeyLabel("K", "⌘")).toBe("K");
  });
});
