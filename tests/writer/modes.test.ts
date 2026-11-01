import { describe, expect, it } from "vitest";

import { writerSchema } from "@/lib/config/schemas/writer";
import { writerJobPayloadSchema } from "@/lib/control/types";
import { SCRUBBED_PAYLOAD_KEYS, scrubPayload } from "@/lib/db/repos/control-requests";
import { buildSnapshot } from "@/lib/writer/snapshot";
import { EMPTY_SELECTION } from "@/lib/writer/types";

const hash = "a".repeat(64);
const materials = {
  question: { text: "Why us?", kind: "question", lengthUnit: "words", lengthValue: 150, outputLanguage: "en", tone: "neutral", variants: [{ id: "safe", hint: "clear" }] },
  job: { title: "Engineer", company: "Acme" },
  jdPoints: [],
  useJdText: false,
  profile: null,
  stories: [],
  emphasis: "ownership",
};
const refs = { storyIds: [], jdPoints: 0, profile: false, emphasis: true };

describe("writer.yaml: the coach and the draft limit", () => {
  it("has defaults, so a file written before they existed keeps working", () => {
    const writer = writerSchema.parse({});
    expect(writer.coach.dimensions.length).toBeGreaterThan(0);
    expect(writer.coach.max_suggestions).toBeGreaterThan(0);
    expect(writer.draft_max_chars).toBeGreaterThan(0);
    // each parse has its own list
    expect(writerSchema.parse({}).coach.dimensions).not.toBe(writer.coach.dimensions);
  });

  it("takes dimensions of your own and rejects bad ones", () => {
    expect(writerSchema.parse({ coach: { dimensions: ["length", "storytelling"] } }).coach.dimensions).toEqual(["length", "storytelling"]);
    for (const dimensions of [[], ["length", "length"], ["Not An Id"], Array.from({ length: 16 }, (_, index) => `d${index}`)]) {
      expect(writerSchema.safeParse({ coach: { dimensions } }).success).toBe(false);
    }
    expect(writerSchema.safeParse({ coach: { unknown_key: 1 } }).success).toBe(false);
    expect(writerSchema.safeParse({ coach: { max_suggestions: 0 } }).success).toBe(false);
    expect(writerSchema.safeParse({ draft_max_chars: 100 }).success).toBe(false);
  });
});

describe("the writer_job payload", () => {
  it("a request queued before polish and review existed is a draft", () => {
    const parsed = writerJobPayloadSchema.parse({ jobId: 1, questionId: 2, mode: "draft", materialsHash: hash, refs, materials });
    expect(parsed).toMatchObject({ mode: "draft", refs: { draft: false }, materials: { draft: null } });
    expect(writerJobPayloadSchema.parse({ jobId: 1, questionId: 2, materialsHash: hash, refs, materials }).mode).toBe("draft");
  });

  it("knows the four modes, the polish option and the reviewed version, and nothing else", () => {
    const base = { jobId: 1, questionId: 2, materialsHash: hash, refs: { ...refs, draft: true }, materials: { ...materials, draft: { text: "Hi.", sentences: ["Hi."] } } };
    expect(writerJobPayloadSchema.safeParse({ ...base, mode: "polish", polish: "language_only" }).success).toBe(true);
    expect(writerJobPayloadSchema.safeParse({ ...base, mode: "coach", versionId: 4 }).success).toBe(true);
    expect(writerJobPayloadSchema.safeParse({ ...base, mode: "coach_rewrite", versionId: 4 }).success).toBe(true);
    expect(writerJobPayloadSchema.safeParse({ ...base, mode: "translate" }).success).toBe(false);
    expect(writerJobPayloadSchema.safeParse({ ...base, mode: "polish", polish: "rewrite_everything" }).success).toBe(false);
    expect(writerJobPayloadSchema.safeParse({ ...base, mode: "coach", versionId: 0 }).success).toBe(false);
    expect(writerJobPayloadSchema.safeParse({ ...base, mode: "coach", extra: 1 }).success).toBe(false);
  });

  it("the text to polish or review lives under `materials`, which ends a request cleared", () => {
    const payload = { jobId: 1, questionId: 2, mode: "polish", polish: "align_to_job", materialsHash: hash, refs: { ...refs, draft: true }, materials: { ...materials, draft: { text: "My private draft." } } };
    const scrubbed = scrubPayload("writer_job", payload);
    expect(JSON.stringify(scrubbed)).not.toContain("My private draft");
    expect(scrubbed).toMatchObject({ scrubbed: true, mode: "polish", polish: "align_to_job", materialsHash: hash });
    expect(SCRUBBED_PAYLOAD_KEYS.writer_job).toEqual(["materials"]);
  });
});

describe("the snapshot of polish and review requests", () => {
  const writer = writerSchema.parse({});
  const input = {
    question: { text: "Why us?", kind: "question" as const, lengthUnit: "words" as const, lengthValue: 150, outputLanguage: "en", tone: "neutral" },
    selection: { ...EMPTY_SELECTION, emphasis: "ownership" },
    job: { title: "Engineer", company: "Acme" },
    jdPoints: [],
    me: null,
    stories: [],
    writer,
  };

  it("a draft from the material has no text and the question kind's styles", () => {
    const { materials: built } = buildSnapshot(input);
    expect(built.draft).toBeNull();
    expect(built.question.variants.map((variant) => variant.id)).toEqual(["safe", "distinctive", "short"]);
  });

  it("a polish or review carries the text and the versions it asks for instead", () => {
    const polish = buildSnapshot({ ...input, draft: { snapshot: { text: "Mine.", sentences: [], suggestions: [], notesLanguage: "en" }, variants: [{ id: "align_to_job", hint: "align_to_job" }] } }).materials;
    expect(polish.draft?.text).toBe("Mine.");
    expect(polish.question.variants).toEqual([{ id: "align_to_job", hint: "align_to_job" }]);
    const review = buildSnapshot({ ...input, draft: { snapshot: { text: "A. B.", sentences: ["A.", "B."], suggestions: [], notesLanguage: "de" }, variants: [] } }).materials;
    expect(review.question.variants).toEqual([]);
    expect(review.draft?.notesLanguage).toBe("de");
  });
});
