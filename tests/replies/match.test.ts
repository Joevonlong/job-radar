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
  it("matches on the company name in the mail", () => {
    const result = run(evidence({ body: "Thanks for applying to Acme Robotics." }), [candidate({ applicationId: 1 }), candidate({ applicationId: 2, companyName: "Other Corp" })]);
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
    const result = run(evidence({ subject: "Your application as Data Engineer", body: "Acme Robotics thanks you." }), [candidate({ applicationId: 1 }), candidate({ applicationId: 2, title: "Office Manager" })]);
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
    const withName = run(evidence({ senderAddress: `no-reply@${domain}`, senderDomain: domain, body: "Thanks for applying to Acme Robotics." }), cands);
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
    const body = "Thanks for applying to Acme Robotics.";
    expect(run(evidence({ category: "rejection", body }), [interested]).match).toBe("unmatched");
    expect(run(evidence({ category: "acknowledgement", body }), [interested]).match).toBe("matched");
  });

  it("nothing in common: unmatched", () => {
    expect(run(evidence({ body: "Hello." }), [candidate({ applicationId: 1 })]).match).toBe("unmatched");
  });

  it("no address, no domain", () => {
    expect(domainOfAddress("Jobs@Careers.Example.COM")).toBe("careers.example.com");
    expect(domainOfAddress("nothing")).toBe("");
  });
});
