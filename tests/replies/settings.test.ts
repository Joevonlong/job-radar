import { describe, expect, it } from "vitest";

import { ConfigError } from "@/lib/config";
import { readRepliesSettings } from "@/lib/replies/settings";

describe("readRepliesSettings", () => {
  it("an unreadable replies.yaml counts as nothing to show", () => {
    const broken = () => {
      throw Object.create(ConfigError.prototype);
    };
    expect(readRepliesSettings(broken as never)).toBeNull();
  });

  it("other errors are not swallowed", () => {
    const failing = () => {
      throw new Error("disk");
    };
    expect(() => readRepliesSettings(failing as never)).toThrow("disk");
  });
});
