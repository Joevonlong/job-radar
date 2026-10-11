// @vitest-environment node
import { describe, expect, it } from "vitest";

import { hammingDistance, simhash } from "@/lib/pipeline/simhash";

const options = { shingleWords: 3, minWords: 30 };

const BASE =
  "We are looking for a senior machine learning engineer to join our platform team in Berlin. You will design and operate large scale training pipelines, work closely with product managers and researchers, mentor junior colleagues and help us ship reliable models to production. You bring strong Python skills, experience with PyTorch and Kubernetes, and a passion for building robust systems. We offer a competitive salary, flexible working hours, a learning budget and thirty days of vacation. Apply now and become part of our growing company.";

describe("simhash", () => {
  it("is deterministic and 16 hex characters", () => {
    const a = simhash(BASE, options);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(simhash(BASE, options)).toBe(a);
  });

  it("ignores case, punctuation and whitespace", () => {
    expect(simhash(BASE.toUpperCase().replace(/ /g, "  ").replace(/,/g, ";"), options)).toBe(simhash(BASE, options));
  });

  it("puts a lightly edited posting within a few bits and an unrelated one far away", () => {
    const edited = BASE.replace("Apply now and become part of our growing company.", "Apply today.");
    const unrelated =
      "Our restaurant in Munich is hiring a head chef to lead the kitchen team. You prepare seasonal menus, manage suppliers and train apprentices while keeping our quality standards high. Experience with regional cuisine and a calm leadership style are important to us. We offer fair pay, shared tips, free meals and a friendly atmosphere in a busy but supportive environment with regular working hours.";
    const base = simhash(BASE, options) as string;
    expect(hammingDistance(base, base)).toBe(0);
    expect(hammingDistance(base, simhash(edited, options) as string)).toBeLessThanOrEqual(12);
    expect(hammingDistance(base, simhash(unrelated, options) as string)).toBeGreaterThan(12);
  });

  it("gives no hash to texts below the minimum word count", () => {
    expect(simhash("too short to compare", options)).toBeNull();
    expect(simhash("", options)).toBeNull();
    expect(simhash(BASE, { shingleWords: 3, minWords: 10_000 })).toBeNull();
  });

  it("measures the Hamming distance over 64 bits", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingDistance("0000000000000000", "0000000000000007")).toBe(3);
    expect(hammingDistance("8000000000000000", "0000000000000001")).toBe(2);
  });
});
