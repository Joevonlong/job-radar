// @vitest-environment node
import { describe, expect, it } from "vitest";

import { AI_CONTROL_REQUEST_KINDS, CONTROL_REQUEST_KINDS, controlLaneOf, HOST_ONLY_CONTROL_REQUEST_KINDS, INTERACTIVE_CONTROL_REQUEST_KINDS } from "@/lib/db/repos/control-requests";

describe("control lanes", () => {
  it("has exactly nine interactive kinds, all of them AI work or the host-only model list refresh", () => {
    expect(INTERACTIVE_CONTROL_REQUEST_KINDS).toEqual(["translate_job", "breakdown_job", "salary_lookup", "test_ai", "writer_job", "writer_fit", "story_extract", "models_sync", "company_research"]);
    expect(INTERACTIVE_CONTROL_REQUEST_KINDS.every((kind) => ([...AI_CONTROL_REQUEST_KINDS, ...HOST_ONLY_CONTROL_REQUEST_KINDS] as readonly string[]).includes(kind))).toBe(true);
  });

  it.each(CONTROL_REQUEST_KINDS)("classifies every origin of %s into exactly one lane", (kind) => {
    for (const payload of [{}, { origin: "auto" }, { origin: "another" }]) {
      const interactive = ["translate_job", "breakdown_job", "salary_lookup", "test_ai", "writer_job", "writer_fit", "story_extract", "models_sync", "company_research"].includes(kind) && payload.origin !== "auto";
      expect(controlLaneOf(kind, payload)).toBe(interactive ? "interactive" : "batch");
    }
  });

  it.each([null, undefined, 3, "auto", [], { origin: null }])("treats an absent origin as user work: %j", (payload) => {
    expect(controlLaneOf("translate_job", payload)).toBe("interactive");
  });
});
