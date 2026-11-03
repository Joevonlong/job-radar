// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mostCommonDomain, registrableDomainOf } from "@/lib/research/domain";

const BOARDS = ["greenhouse.io", "linkedin.com", "myworkdayjobs.com"];

describe("the domain a link belongs to", () => {
  it.each([
    ["https://careers.example.de/jobs/1", "example.de"],
    ["https://jobs.company.co.uk/apply?x=1", "company.co.uk"],
    ["careers.example.de", "example.de"],
    ["EXAMPLE.de.", "example.de"],
    ["http://www.example-company.com:8080/", "example-company.com"],
    ["acme.github.io", "acme.github.io"],
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
