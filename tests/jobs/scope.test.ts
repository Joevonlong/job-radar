import { describe, expect, it } from "vitest";

import { JOB_SCOPES } from "@/lib/jobs/constants";
import { isArchivedReason, resolveJobScope } from "@/lib/jobs/scope";

describe("job scope", () => {
  it("keeps the legacy rule only when scope is absent", () => {
    for (const scope of [null, undefined]) {
      for (const statuses of [null, undefined, []]) expect(resolveJobScope(scope, statuses)).toBe("current");
      for (const statuses of [["active"], ["closed"], ["possibly_closed", "closed"]]) expect(resolveJobScope(scope, statuses)).toBe("all");
    }
  });

  it("keeps explicit scopes regardless of status selection", () => {
    for (const scope of JOB_SCOPES) {
      for (const statuses of [null, undefined, [], ["active"], ["possibly_closed"], ["closed"]]) expect(resolveJobScope(scope, statuses)).toBe(scope);
    }
  });

  it("archives manual, gone and dormant reasons only", () => {
    for (const reason of ["manual", "gone", "dormant"]) expect(isArchivedReason(reason)).toBe(true);
    for (const reason of [null, undefined, "possibly", "phrase", "", "closed"]) expect(isArchivedReason(reason)).toBe(false);
  });
});
