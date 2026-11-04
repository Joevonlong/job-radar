// @vitest-environment node
import { describe, expect, it } from "vitest";

import { displayDomain } from "@/lib/research/display-domain";
import { mostCommonDomain, registrableDomainOf, shownWebsite } from "@/lib/research/domain";

const BOARDS = ["greenhouse.io", "linkedin.com", "myworkdayjobs.com"];

describe("the domain a link belongs to", () => {
  it.each([
    ["https://careers.example.de/jobs/1", "example.de"],
    ["https://jobs.company.co.uk/apply?x=1", "company.co.uk"],
    ["careers.example.de", "example.de"],
    ["EXAMPLE.de.", "example.de"],
    ["http://www.example-company.com:8080/", "example-company.com"],
    ["acme.github.io", "acme.github.io"],
    // an international name is kept in the form that is looked up and sent (punycode), whether it is typed with its letters or already encoded
    ["https://www.münchen-bau.de/jobs", "xn--mnchen-bau-9db.de"],
    ["https://karriere.xn--mnchen-bau-9db.de", "xn--mnchen-bau-9db.de"],
    ["xn--80aswg.xn--p1ai", "xn--80aswg.xn--p1ai"],
  ])("%s -> %s", (input, domain) => {
    expect(registrableDomainOf(input, BOARDS)).toBe(domain);
  });

  it.each(["https://boards.greenhouse.io/acme/jobs/1", "https://acme.wd3.myworkdayjobs.com/x", "linkedin.com", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://[::1]/", "localhost", "http://fritz.box/", "printer.local", "co.uk", "github.io", "single", "user@example.com", "ftp://example.com/", "not a domain", ""])("refuses %j", (input) => {
    expect(registrableDomainOf(input, BOARDS)).toBeNull();
  });
});

describe("the domain a link belongs to, with an empty host list", () => {
  it("still refuses wildcard DNS names, and takes one site under a shared host", () => {
    expect(registrableDomainOf("https://10.0.0.1.nip.io/careers", [])).toBeNull();
    expect(registrableDomainOf("https://notion.site", [])).toBeNull();
    expect(registrableDomainOf("https://acme.notion.site/jobs", [])).toBe("acme.notion.site");
  });
});

describe("the domain a company's links suggest", () => {
  it("takes the most common candidate, skips the rest, and does not depend on the order", () => {
    const urls = ["https://careers.acme.de/1", "https://boards.greenhouse.io/acme", "https://jobs.acme.de/2", "https://other.example.org/", "nonsense"];
    expect(mostCommonDomain(urls, BOARDS)).toBe("acme.de");
    expect(mostCommonDomain([...urls].reverse(), BOARDS)).toBe("acme.de");
    expect(mostCommonDomain(["https://b.example.org", "https://a.example.net"], BOARDS)).toBe("example.net");
  });

  it("finds nothing among job boards alone", () => {
    expect(mostCommonDomain(["https://boards.greenhouse.io/acme", "https://www.linkedin.com/jobs/1"], BOARDS)).toBeNull();
  });
});

describe("the website a stored row shows", () => {
  const research = { company: { non_company_hosts: ["board.com"] } } as unknown as Parameters<typeof shownWebsite>[1];
  it("hides a domain, confirmed or inferred, that the host list now refuses", () => {
    expect(shownWebsite({ websiteDomain: "acme.com", websiteDomainSource: "user" }, research)).toEqual({ domain: "acme.com", source: "user" });
    expect(shownWebsite({ websiteDomain: "acme.board.com", websiteDomainSource: "user" }, research)).toBeNull();
    expect(shownWebsite({ websiteDomain: "acme.board.com", websiteDomainSource: "inferred" }, research)).toBeNull();
    expect(shownWebsite({ websiteDomain: null, websiteDomainSource: null }, research)).toBeNull();
  });
});

describe("how a domain is shown", () => {
  it("decodes international names to their letters and leaves ordinary and malformed names alone", () => {
    expect(displayDomain("xn--mnchen-bau-9db.de")).toBe("münchen-bau.de");
    expect(displayDomain("karriere.xn--mnchen-bau-9db.de")).toBe("karriere.münchen-bau.de");
    expect(displayDomain("xn--80aswg.xn--p1ai")).toBe("сайт.рф");
    expect(displayDomain("example.de")).toBe("example.de");
    expect(displayDomain("xn--!!.de")).toBe("xn--!!.de");
    expect(displayDomain("xn--.de")).toBe("xn--.de");
  });

  it("keeps the xn-- form of a label that could pass for another name or hides characters", () => {
    // Cyrillic a among Latin letters; right-to-left override; zero-width character; C1 control
    for (const name of ["xn--pple-43d.com", "xn--zvg.com", "xn--zug.com", "xn--a.com"]) expect(displayDomain(name), name).toBe(name);
    // a whole-Cyrillic or whole-Latin label is fine, and other labels of the same name are judged on their own
    expect(displayDomain("xn--mnchen-bau-9db.de")).toBe("münchen-bau.de");
    expect(displayDomain("xn--pple-43d.xn--mnchen-bau-9db.de")).toBe("xn--pple-43d.münchen-bau.de");
  });
});
