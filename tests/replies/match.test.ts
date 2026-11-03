import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { repliesSchema } from "@/lib/config/schemas/replies";
import { domainOfAddress, matchReply, type ReplyEvidence } from "@/lib/replies/match";
import type { MatchCandidate } from "@/lib/replies/types";

const config = repliesSchema.parse(parse(fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/config/defaults/replies.yaml"), "utf8")));
const SUFFIXES = ["gmbh", "ag", "inc"];
const SINCE = new Date("2026-09-01T00:00:00Z");
const RECEIVED = new Date("2026-10-01T00:00:00Z");

function candidate(over: Partial<MatchCandidate> & { applicationId: number }): MatchCandidate {
  return { jobId: over.applicationId * 10, status: "applied", companyName: "Acme Robotics GmbH", aliases: [], atsToken: null, title: "Data Engineer", hosts: [], since: SINCE, ...over };
}
function evidence(over: Partial<ReplyEvidence> = {}): ReplyEvidence {
  return { category: "rejection", senderAddress: "jobs@mailer.example", senderName: "", senderDomain: "mailer.example", subject: "Your application", body: "", threadId: null, receivedAt: RECEIVED, ...over };
}
const run = (e: ReplyEvidence, cands: MatchCandidate[], threads = [] as { threadId: string; senderDomain: string; applicationId: number }[]) => matchReply(e, cands, threads, config.match, SUFFIXES);

describe("matchReply", () => {
  it("matches on the company name in the subject", () => {
    const result = run(evidence({ subject: "Your application at Acme Robotics" }), [candidate({ applicationId: 1 }), candidate({ applicationId: 2, companyName: "Other Corp" })]);
    expect(result.match).toBe("matched");
    expect(result.applicationId).toBe(1);
    expect(result.jobId).toBe(10);
    expect(result.candidates[0]?.hits).toContain("company");
  });

  it("a word inside another word is not the company", () => {
    const result = run(evidence({ body: "We love acmerobotic things and Data engineering." }), [candidate({ applicationId: 1, title: "Quantum Sculptor" })]);
    expect(result.match).toBe("unmatched");
  });

  it("two equally good applications at one company stay ambiguous", () => {
    const result = run(evidence({ body: "Thanks for applying to Acme Robotics." }), [candidate({ applicationId: 1, title: "Alpha Role" }), candidate({ applicationId: 2, title: "Beta Role" })]);
    expect(result.match).toBe("ambiguous");
    expect(result.applicationId).toBeNull();
    expect(result.candidates.map((c) => c.applicationId).sort()).toEqual([1, 2]);
  });

  it("the job title tells two applications at one company apart", () => {
    const result = run(evidence({ subject: "Your application at Acme Robotics as Data Engineer" }), [candidate({ applicationId: 1 }), candidate({ applicationId: 2, title: "Office Manager" })]);
    expect(result.match).toBe("matched");
    expect(result.applicationId).toBe(1);
  });

  it("an earlier confirmed thread from the same sender domain decides", () => {
    const result = run(evidence({ threadId: "t1", subject: "About the next step", body: "See you soon." }), [candidate({ applicationId: 1 })], [{ threadId: "t1", senderDomain: "mailer.example", applicationId: 1 }]);
    expect(result.match).toBe("matched");
    expect(result.candidates[0]?.hits).toContain("thread");
  });

  it("a thread from another sender, or with a generic subject, only adds to the score", () => {
    const SPECIFIC = "Your interview at Acme next week";
    const app = candidate({ applicationId: 1, companyName: "Zebra Works" });
    const otherSender = [{ threadId: "t1", senderDomain: "other.example", applicationId: 1 }];
    const sameSender = [{ threadId: "t1", senderDomain: "mailer.example", applicationId: 1 }];
    expect(run(evidence({ threadId: "t1", subject: SPECIFIC, body: "See you soon." }), [app], otherSender).match).toBe("ambiguous");
    expect(run(evidence({ threadId: "t1", subject: "Your application", body: "See you soon." }), [app], sameSender).match).toBe("ambiguous");
    expect(run(evidence({ threadId: "t1", subject: SPECIFIC, body: "See you soon." }), [app], sameSender).match).toBe("matched");
    expect(run(evidence({ threadId: "t1", subject: SPECIFIC, body: "Zebra Works here." }), [app], otherSender).match).toBe("matched");
  });

  it("an applicant-tracking sender needs the company as well", () => {
    const domain = config.match.ats_sender_domains[0] ?? "greenhouse.io";
    const cands = [candidate({ applicationId: 1 }), candidate({ applicationId: 2, companyName: "Other Corp", title: "Quantum Sculptor" })];
    const withName = run(evidence({ senderAddress: `no-reply@${domain}`, senderDomain: domain, subject: "Thanks for applying to Acme Robotics" }), cands);
    expect(withName.applicationId).toBe(1);
    const without = run(evidence({ senderAddress: `no-reply@${domain}`, senderDomain: domain, body: "Thanks for applying." }), cands);
    expect(without.match).toBe("unmatched");
  });

  it("a mail from before the application began does not match it", () => {
    const result = run(evidence({ receivedAt: new Date("2026-08-01T00:00:00Z"), body: "Thanks for applying to Acme Robotics." }), [candidate({ applicationId: 1 })]);
    expect(result.match).toBe("unmatched");
  });

  it("an `interested` application only takes an acknowledgement", () => {
    const interested = candidate({ applicationId: 1, status: "interested" });
    const subject = "Thanks for applying to Acme Robotics";
    expect(run(evidence({ category: "rejection", subject }), [interested]).match).toBe("unmatched");
    expect(run(evidence({ category: "acknowledgement", subject }), [interested]).match).toBe("matched");
  });

  describe("a company mentioned in passing", () => {
    const filler = "Lorem ipsum dolor sit amet. ".repeat(120);

    it("in the body alone it is at most ambiguous, also with the title", () => {
      const siemens = candidate({ applicationId: 1, companyName: "Siemens", title: "Data Engineer" });
      const footer = run(evidence({ body: "See you soon. Our partners: Siemens." }), [siemens]);
      expect(footer.match).toBe("ambiguous");
      expect(footer.candidates[0]?.hits).toEqual(["company_body"]);
      expect(run(evidence({ body: "Your Data Engineer application. Partners: Siemens." }), [siemens]).match).toBe("ambiguous");
    });

    it("beyond the scanned start of the body it is no evidence", () => {
      const zalando = candidate({ applicationId: 1, companyName: "Zalando" });
      expect(filler.length).toBeGreaterThan(config.match.company_scan_chars);
      expect(run(evidence({ body: `${filler}We also worked with Zalando.` }), [zalando]).match).toBe("unmatched");
    });

    it("a name that is an everyday word needs the sender's name", () => {
      const forward = candidate({ applicationId: 1, companyName: "Forward" });
      expect(run(evidence({ subject: "Moving forward", body: "We decided not to move forward." }), [forward]).match).toBe("unmatched");
      expect(run(evidence({ senderName: "Forward Recruiting" }), [forward]).match).toBe("matched");
    });

    it("the tracking system's own name on its own mail decides nothing", () => {
      const domain = "personio.de";
      const personio = candidate({ applicationId: 1, companyName: "Personio" });
      const sent = { senderAddress: `no-reply@${domain}`, senderDomain: domain };
      const footer = run(evidence({ ...sent, body: "Thanks for applying. Powered by Personio" }), [personio]);
      expect(footer.match).toBe("ambiguous");
      expect(footer.score).toBe(config.match.weights.company_body);
      const named = run(evidence({ ...sent, senderName: "Personio", subject: "Thanks for applying to Acme Robotics", body: "Powered by Personio" }), [personio, candidate({ applicationId: 2 })]);
      expect(named.match).toBe("matched");
      expect(named.applicationId).toBe(2);
    });

    it("the company's own domain and a mention in the body together still leave it to the user below the score", () => {
      const own = candidate({ applicationId: 1, companyName: "Siemens", hosts: ["siemens.example"], title: "Quantum Sculptor" });
      expect(run(evidence({ senderDomain: "siemens.example", senderAddress: "hr@siemens.example", body: "Greetings from Siemens." }), [own]).match).toBe("ambiguous");
    });
  });

  it("nothing in common: unmatched", () => {
    expect(run(evidence({ body: "Hello." }), [candidate({ applicationId: 1 })]).match).toBe("unmatched");
  });

  it("no address, no domain", () => {
    expect(domainOfAddress("Jobs@Careers.Example.COM")).toBe("careers.example.com");
    expect(domainOfAddress("nothing")).toBe("");
  });
});
