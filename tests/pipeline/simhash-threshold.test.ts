// @vitest-environment node
import { describe, expect, it } from "vitest";

import { hammingDistance, simhash } from "@/lib/pipeline/simhash";

import { shippedPipeline } from "./helpers";

/**
 * Borderline cases behind `dedupe.simhash_max_distance` (calibrated on real data, see
 * the threshold review of 2026-10). Realistic JD-sized texts (about 180 words) built from a shared
 * company boilerplate and a role paragraph; the distances are deterministic (SHA-256 shingles).
 */
const config = shippedPipeline();
const options = { shingleWords: config.dedupe.simhash_shingle_words, minWords: config.dedupe.simhash_min_words };

const INTRO =
  "Join our product engineering group where small teams own whole services from design to production. We value clear writing, careful code review, steady on-call rotations and honest retrospectives.";
const ROLE =
  "As a backend engineer you will build and run the services behind our checkout flow. You write Go and Python, design APIs with the frontend team, tune PostgreSQL queries, add metrics and alerts, and review the work of your teammates. We expect at least four years of professional experience, a good grasp of distributed systems and a habit of documenting decisions.";
const OTHER_ROLE =
  "As a data engineer you will build and run the pipelines behind our analytics platform. You write Spark and SQL, model warehouse tables with the analytics team, schedule batch jobs, add data quality checks, and review the work of your teammates. We expect at least four years of professional experience, a good grasp of columnar storage and a habit of documenting decisions.";
const BENEFITS =
  "We offer a competitive salary, a yearly learning budget, flexible hours, thirty days of vacation, a modern laptop of your choice, a company pension plan and a relocation package where needed. Our offices have bike storage, fresh fruit and quiet rooms, and we run a friendly hybrid model with two office days per week.";
const LEGAL =
  "We welcome applications from everyone and decide on skills and motivation. Send us your CV and a few lines about a project you are proud of, and we will reply within one week.";

const jd = (where: string, role = ROLE): string => `${INTRO} ${role} Location: ${where}. ${BENEFITS} ${LEGAL}`;
const distance = (a: string, b: string): number => hammingDistance(simhash(a, options) as string, simhash(b, options) as string);

describe("simhash_max_distance on borderline postings", () => {
  const max = config.dedupe.simhash_max_distance;

  it("keeps the threshold the real-data calibration chose", () => {
    expect(max).toBe(3);
  });

  it("merges the same JD posted for another city (only the city differs)", () => {
    expect(distance(jd("Berlin"), jd("Munich"))).toBeLessThanOrEqual(max);
  });

  it("keeps a different role that shares the company boilerplate apart", () => {
    expect(distance(jd("Berlin"), jd("Berlin", OTHER_ROLE))).toBeGreaterThan(max);
  });

  it("does not merge when a second location sentence is added (a known miss, traded for no false merges)", () => {
    // Same title in two cities with different location blurbs is a true duplicate at distance 4-5 in the real data;
    // widening the threshold to catch it would also merge many different jobs (see the research note).
    expect(distance(jd("Berlin"), jd("Munich, Germany (hybrid, remote within the EU possible)"))).toBeGreaterThan(max);
  });
});
