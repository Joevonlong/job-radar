// @vitest-environment node
import { describe, expect, it } from "vitest";

import { enterUpload } from "@/lib/stories/upload-gate";

describe("the upload gate", () => {
  it("turns away an upload beyond the limit and gives the slot back once", () => {
    const first = enterUpload(2);
    const second = enterUpload(2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(enterUpload(2)).toBeNull();
    first?.();
    first?.();
    // releasing twice frees one slot only
    const third = enterUpload(2);
    expect(third).not.toBeNull();
    expect(enterUpload(2)).toBeNull();
    second?.();
    third?.();
    expect(enterUpload(1)).not.toBeNull();
  });
});
