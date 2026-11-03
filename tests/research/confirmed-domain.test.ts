import { describe, expect, it } from "vitest";

import { confirmedWebsiteDomain } from "@/lib/db/repos/company-research";

describe("confirmedWebsiteDomain", () => {
  const user = (domain: string) => ({ websiteDomain: domain, websiteDomainSource: "user" });

  it("gives a confirmed public domain", () => {
    expect(confirmedWebsiteDomain(user("acme-robotics.com"), ["board.com"])).toBe("acme-robotics.com");
  });

  it("refuses one the host list now names, itself or below it, even though the user confirmed it earlier", () => {
    expect(confirmedWebsiteDomain(user("board.com"), ["board.com"])).toBeNull();
    expect(confirmedWebsiteDomain(user("acme.board.com"), ["board.com"])).toBeNull();
    expect(confirmedWebsiteDomain(user("notboard.com"), ["board.com"])).toBe("notboard.com");
  });

  it("never gives an inferred domain, a missing one or a name that is not public", () => {
    expect(confirmedWebsiteDomain({ websiteDomain: "acme.example", websiteDomainSource: "inferred" }, [])).toBeNull();
    expect(confirmedWebsiteDomain({ websiteDomain: null, websiteDomainSource: null }, [])).toBeNull();
    expect(confirmedWebsiteDomain(user("localhost"), [])).toBeNull();
  });
});
