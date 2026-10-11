import { describe, expect, it } from "vitest";

import { PARSERS, platformOfSender } from "@/lib/channels/email";
import { canonicalUrl, unwrapLink } from "@/lib/channels/email/html";

import { shippedChannels } from "../helpers";
import { fixtureHtml } from "./helpers";

const parse = (platform: keyof typeof PARSERS, name: string) => PARSERS[platform].parse(fixtureHtml(name));

describe("LinkedIn parser", () => {
  it("reads every card of a multi-job digest: id, canonical link, company, location, workplace, salary", () => {
    const jobs = parse("linkedin", "linkedin-digest-en");
    expect(jobs).toEqual([
      {
        id: "3945123456",
        url: "https://www.linkedin.com/jobs/view/3945123456/",
        title: "Machine Learning Engineer (m/w/d)",
        company: "Nordwind Robotics GmbH",
        location: "Berlin, Berlin, Germany",
        workplace: "hybrid",
        salaryText: "€70K/yr - €90K/yr",
        snippet: null,
      },
      expect.objectContaining({ id: "3945987654", company: "Lumen Labs", location: "Munich, Bavaria, Germany", workplace: null, salaryText: null }),
      expect.objectContaining({ id: "3946000111", company: "Helix Systems AG", location: "Germany", workplace: "remote" }),
    ]);
  });

  it("drops badges, alumni lines and 'View job' buttons; ignores the see-all-jobs and footer links", () => {
    const jobs = parse("linkedin", "linkedin-digest-en");
    expect(jobs).toHaveLength(3);
    for (const job of jobs) expect(job.snippet).toBeNull();
  });

  it("handles the German variant: redirect-wrapped links, slug links, missing location, a logo-only block without title", () => {
    const jobs = parse("linkedin", "linkedin-digest-de");
    expect(jobs.map((j) => j.id)).toEqual(["3951112233", "3950001122", "3950777888"]);
    expect(jobs[0]).toMatchObject({ title: "Senior Data Scientist (w/m/d)", company: "Brandt Analytics GmbH", location: "Hamburg, Hamburg, Deutschland", workplace: null });
    expect(jobs[0]?.url).toBe("https://www.linkedin.com/jobs/view/3951112233/");
    expect(jobs[1]).toMatchObject({ company: "Kestrel Mobility SE", location: "München, Bayern, Deutschland", workplace: "onsite" });
    expect(jobs[2]).toMatchObject({ company: "Orbit Intelligence GmbH", location: null });
  });
});

describe("StepStone parser", () => {
  it("reads table cards: id from the -inline.html link, no tracking parameters, salary, teaser", () => {
    const jobs = parse("stepstone", "stepstone-alert-table");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toEqual({
      id: "11234567",
      url: "https://www.stepstone.de/stellenangebote--Machine-Learning-Engineer-m-w-d-Berlin-Nordwind-Robotics--11234567-inline.html",
      title: "Machine Learning Engineer (m/w/d)",
      company: "Nordwind Robotics GmbH",
      location: "Berlin",
      workplace: null,
      salaryText: "Gehalt: 65.000 € - 80.000 € pro Jahr",
      snippet: "Vollzeit · Festanstellung\nEntwickeln Sie produktionsreife ML-Modelle für unsere Robotik-Plattform und arbeiten Sie eng mit dem Forschungsteam zusammen.",
    });
    expect(jobs[1]).toMatchObject({ location: "Berlin-Mitte", salaryText: null });
  });

  it("never takes a salary estimate for the posting's salary (C3)", () => {
    const [, , third] = parse("stepstone", "stepstone-alert-table");
    expect(third).toMatchObject({ id: "11235120", salaryText: null });
    expect(third?.snippet).toBeNull();
  });

  it("handles the div-based layout with click-tracking wrapper links", () => {
    const jobs = parse("stepstone", "stepstone-alert-div");
    expect(jobs.map((j) => [j.id, j.company, j.location])).toEqual([
      ["11300001", "Kestrel Mobility SE", "Hamburg"],
      ["11300777", "Orbit Intelligence GmbH", "Hamburg"],
    ]);
    expect(jobs[0]?.url).toBe("https://www.stepstone.de/stellenangebote--Data-Engineer-Hamburg-Kestrel-Mobility--11300001-inline.html");
    expect(jobs[0]?.snippet).toContain("Datenplattform");
  });
});

describe("Indeed parser", () => {
  it("reads cards: jk id, viewjob link, company, location, salary, teaser; drops badges and the company rating", () => {
    const jobs = parse("indeed", "indeed-alert-en");
    expect(jobs[0]).toEqual({
      id: "8f2c6a1b9d3e4f70",
      url: "https://de.indeed.com/viewjob?jk=8f2c6a1b9d3e4f70",
      title: "Machine Learning Engineer",
      company: "Nordwind Robotics",
      location: "Berlin",
      workplace: null,
      salaryText: "€70,000 - €90,000 a year",
      snippet: "Join our applied research group and ship models to production.",
    });
    expect(jobs[1]).toMatchObject({ company: "Lumen Labs", location: "Munich", workplace: "hybrid", snippet: null });
    expect(jobs[2]).toMatchObject({ id: "0f9e8d7c6b5a4f3e", company: "Helix Systems", location: null, workplace: "remote" });
  });

  it("splits 'Company - Location' when there is no separate location line; sponsored links without jk are identified by their cleaned link", () => {
    const jobs = parse("indeed", "indeed-alert-de");
    expect(jobs[0]).toMatchObject({ id: "c0ffee1234567890", company: "Brandt Analytics GmbH", location: "Hamburg", salaryText: "65.000 € - 80.000 € pro Jahr", snippet: null });
    expect(jobs[1]).toMatchObject({ id: null, company: "Kestrel Mobility SE", location: "Hamburg", title: "MLOps Engineer (m/w/d)" });
    expect(jobs[1]?.url).toMatch(/^https:\/\/de\.indeed\.com\/pagead\/clk\?/);
    expect(jobs[1]?.url).not.toContain("tk=");
  });
});

describe("XING parser", () => {
  it("reads cards: id from the /jobs/<slug>-<id> link, salary, teaser; drops badges and the salary prediction", () => {
    const jobs = parse("xing", "xing-alert-1");
    expect(jobs[0]).toEqual({
      id: "122334455",
      url: "https://www.xing.com/jobs/berlin-machine-learning-engineer-m-w-d-122334455",
      title: "Machine Learning Engineer (m/w/d)",
      company: "Nordwind Robotics GmbH",
      location: "Berlin",
      workplace: null,
      salaryText: "€ 65.000 - 80.000",
      snippet: "Vollzeit",
    });
    expect(jobs[1]).toMatchObject({ location: "München", salaryText: null, snippet: "Vollzeit\nGestalten Sie die KI-Strategie eines wachsenden Scale-ups mit." });
    expect(jobs[2]).toMatchObject({ company: "Brandt Analytics GmbH", snippet: null });
  });

  it("keeps a card with missing fields (company/location null) and ignores search links", () => {
    const jobs = parse("xing", "xing-alert-2");
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({ id: "133445700", title: "Platform Engineer (m/w/d)", company: null, location: null });
  });
});

describe("resilience", () => {
  it("returns no cards for HTML without job links, for empty and for malformed input", () => {
    for (const parser of Object.values(PARSERS)) {
      expect(parser.parse("")).toEqual([]);
      expect(parser.parse("<html><body><p>Your account was updated.</p><a href='https://www.linkedin.com/comm/psettings'>Settings</a></body></html>")).toEqual([]);
      expect(parser.parse("<table><tr><td><a href='https://x.test'")).toEqual([]);
    }
  });

  it("a single-job email: the card stops before the footer, whose text is not read as teaser", () => {
    const html = `<body><table><tr><td><a href="https://www.linkedin.com/comm/feed/">LinkedIn</a></td></tr>
      <tr><td><div><a href="https://www.linkedin.com/jobs/view/3999000111/">AI Engineer</a><br>Foo GmbH<br>Berlin, Germany</div></td></tr>
      <tr><td>This email was intended for Test Person. <a href="https://www.linkedin.com/comm/psettings/email-unsubscribe">Unsubscribe</a></td></tr></table></body>`;
    expect(PARSERS.linkedin.parse(html)).toEqual([
      { id: "3999000111", url: "https://www.linkedin.com/jobs/view/3999000111/", title: "AI Engineer", company: "Foo GmbH", location: "Berlin, Germany", workplace: null, salaryText: null, snippet: null },
    ]);
  });

  it("one job linked three times (logo, title, button) is one card", () => {
    const html = `<table><tr><td>
      <a href="https://www.xing.com/jobs/berlin-ml-engineer-123456789?x=1"><img src="l.png"></a>
      <a href="https://www.xing.com/jobs/berlin-ml-engineer-123456789?x=2">ML Engineer</a><p>Foo AG</p><p>Berlin</p>
      <a href="https://www.xing.com/jobs/berlin-ml-engineer-123456789?x=3">Job ansehen</a></td></tr></table>`;
    expect(PARSERS.xing.parse(html)).toHaveLength(1);
  });

  it("preheader padding and hidden text are not read as card text", () => {
    const html = `<body><div style="display:none">hidden preheader text</div>
      <table><tr><td><a href="https://www.linkedin.com/jobs/view/3999000222/">Data Engineer</a><p>&#847;&zwnj;&nbsp;Bar GmbH</p><p>Hamburg</p></td></tr></table></body>`;
    expect(PARSERS.linkedin.parse(html)[0]).toMatchObject({ company: "Bar GmbH", location: "Hamburg" });
  });
});

describe("links", () => {
  it("unwrapLink follows (nested) redirect wrappers and rejects non-http links", () => {
    const inner = "https://www.linkedin.com/comm/jobs/view/3945123456/?trackingId=abc";
    const once = `https://www.linkedin.com/e/v2?e=1&url=${encodeURIComponent(inner)}`;
    const twice = `https://click.example.test/r?u=${encodeURIComponent(once)}`;
    expect(unwrapLink(twice)?.toString()).toBe(inner);
    expect(unwrapLink("mailto:a@b.test")).toBeNull();
    expect(unwrapLink("javascript:alert(1)")).toBeNull();
    expect(unwrapLink("not a url")).toBeNull();
  });

  it("canonicalUrl drops tracking parameters and fragments and sorts the rest", () => {
    expect(canonicalUrl(new URL("https://de.indeed.com/pagead/clk?tk=1&utm_source=x&mo=r&ad=7#frag"))).toBe("https://de.indeed.com/pagead/clk?ad=7&mo=r");
  });
});

describe("sender dispatch", () => {
  const senders = shippedChannels().sources.gmail.senders;

  it.each([
    ["jobalerts-noreply@linkedin.com", "linkedin"],
    ["Jobs@MAIL.STEPSTONE.DE", "stepstone"],
    ["noreply@stepstone.com", "stepstone"],
    ["alert@indeed.com", "indeed"],
    ["donotreply@jobalert.indeed.com", "indeed"],
    ["no-reply@mail.xing.com", "xing"],
  ])("%s -> %s", (address, platform) => {
    expect(platformOfSender(address, senders)).toBe(platform);
  });

  it("does not match look-alike domains or empty senders", () => {
    expect(platformOfSender("x@notlinkedin.com", senders)).toBeNull();
    expect(platformOfSender("x@linkedin.com.evil.test", senders)).toBeNull();
    expect(platformOfSender("", senders)).toBeNull();
  });
});
