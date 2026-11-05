import { z } from "zod";
import { templateProblem } from "./naming";
import { BUILTINS, parseTag } from "./sections";
import type { BuiltinName, BuiltinRef, CustomSection, Item } from "./sections";

const date = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : v),
  z.string().regex(/^(\d{4}(-(0[1-9]|1[0-2]))?|present)$/, 'expected "YYYY", "YYYY-MM" or "present"'),
);

const ACCENT = /^(#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[\d.\s,%/+-]|deg|turn|rad|none)*\)|[a-z]+)$/i;

const str = z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string());

const text = z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string().refine((s) => s.trim() !== "", "must not be empty"));

const endsBefore = (start: string, end: string) => {
  const n = Math.min(start.length, end.length);
  return end !== "present" && start.slice(0, n) > end.slice(0, n);
};

const link = z.object({ label: z.string(), url: z.string() });

export const isoDay = z.preprocess(
  (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10) : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a day "YYYY-MM-DD"')
    .refine((d) => {
      const t = new Date(`${d}T00:00:00Z`);
      return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
    }, "not a real calendar day"),
);

const lines = (max: number, what: string) =>
  z
    .union([text, z.array(text)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .refine((v) => v.length >= 1 && v.length <= max, `${what} takes 1–${max} lines`);

const Signature = z.strictObject({
  place: text.optional(),
  date: z.union([z.literal("auto"), isoDay]).default("auto"),
  image: text.optional(),
});

const entry = z.object({
  start: date,
  end: date.optional(),
  location: z.string().optional(),
  summary: z.string().optional(),
  bullets: z.array(z.string()).default([]),
  stack: z.array(z.string()).default([]),
});

const datedList = <T extends z.ZodType<{ start: string; end?: string }>>(item: T) =>
  z.array(item.superRefine((e, ctx) => {
    if (e.end !== undefined && endsBefore(e.start, e.end)) ctx.addIssue({ code: "custom", message: `"end" (${e.end}) is before "start" (${e.start})`, path: ["end"] });
  })).default([]);

const BUILTIN_HINT = `use one of: ${BUILTINS.join(", ")}, an object { use, title } to retitle one, or an object { title, items }`;
const ENTRY_KEYS = ["heading", "sub", "url", "date", "start", "end", "location", "text", "bullets", "tags"];
const KNOWN_KEYS = [...ENTRY_KEYS, "label", "items"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (msg: string) => ({ kind: "bad", msg });

const tagItem = (v: unknown, tags: boolean): unknown => {
  if (typeof v === "number") v = String(v);
  if (typeof v === "string") {
    if (tags) return { kind: "tag", text: v };
    const m = /^\[(x| )\] ([^]*)$/.exec(v);
    if (m && !m[2].trim()) return bad("empty checklist item — write some text after \"[x] \" / \"[ ] \"");
    return m ? { kind: "check", text: m[2], done: m[1] === "x" } : { kind: "bullet", text: v };
  }
  if (Array.isArray(v)) return bad('this item was read as a list — wrap it in quotes: "[ ] …" or "[[…]] …"');
  if (!isObj(v)) return bad("unrecognized item — expected a string, { heading }, { label, items } or { text }");
  if ("heading" in v) return { ...v, kind: "entry" };
  if ("label" in v) return { ...v, kind: "group" };
  if ("text" in v) return { ...v, kind: "text" };
  const keys = Object.keys(v);
  if (keys.length === 1 && !KNOWN_KEYS.includes(keys[0])) return bad('this item was read as "key: value" — wrap the whole line in quotes');
  return bad("unrecognized item — expected a string, { heading }, { label, items } or { text }");
};

const tagSection = (v: unknown): unknown => {
  if (typeof v === "string") return { kind: "builtin", name: v };
  if (isObj(v) && "use" in v) return { ...v, kind: "rename" };
  if (isObj(v)) return { ...v, kind: "custom", items: Array.isArray(v.items) ? v.items.map((x) => tagItem(x, v.layout === "tags")) : v.items };
  return bad(`unrecognized section — ${BUILTIN_HINT}`);
};

const Bad = z.strictObject({ kind: z.literal("bad"), msg: z.string() }).superRefine((v, ctx) => ctx.addIssue({ code: "custom", message: v.msg }));

const ItemU = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bullet"), text }),
  z.strictObject({ kind: z.literal("check"), text, done: z.boolean() }),
  z.strictObject({ kind: z.literal("group"), label: text, items: z.array(text).min(1, "items needs at least one entry") }),
  z.strictObject({ kind: z.literal("text"), text }),
  z.strictObject({
    kind: z.literal("entry"),
    heading: text,
    sub: str.optional(),
    url: str.optional(),
    date: date.optional(),
    start: date.optional(),
    end: date.optional(),
    location: str.optional(),
    text: str.optional(),
    bullets: z.array(text).default([]),
    tags: z.array(text).default([]),
  }),
  z.strictObject({ kind: z.literal("tag"), text }),
  Bad,
]);
type RawItem = z.infer<typeof ItemU>;

const WHAT: Record<string, string> = { bullet: "bullet", check: "bullet", group: "{ label, items }", text: "{ text }", entry: "{ heading }", tag: "plain string" };

const ALLOWED: Record<string, { kinds: string[]; says: string }> = {
  list: { kinds: [], says: "" },
  grid: { kinds: ["bullet", "check", "group", "text"], says: "bullets, checklist items, { label, items } or { text } (use layout list for { heading })" },
  tags: { kinds: ["tag"], says: "plain strings only" },
};

function normalise(it: RawItem): Item {
  switch (it.kind) {
    case "tag":
      return { kind: "tag", tag: parseTag(it.text) };
    case "entry": {
      const { kind, date: d, start, end, bullets, tags, ...rest } = it;
      return { kind, ...rest, ...(d ?? start ? { start: d ?? start } : {}), ...(end && !d ? { end } : {}), bullets, tags: tags.map(parseTag) };
    }
    case "bad":
      throw new Error("unreachable");
    default:
      return it;
  }
}

const Builtin = z
  .strictObject({ kind: z.literal("builtin"), name: z.string() })
  .superRefine((v, ctx) => {
    if (!(BUILTINS as readonly string[]).includes(v.name)) ctx.addIssue({ code: "custom", message: `unknown section "${v.name}" — ${BUILTIN_HINT}` });
  })
  .transform((v) => v.name as BuiltinName);

const unknownBuiltin = (name: string) => `unknown section "${name}" — use one of: ${BUILTINS.join(", ")}`;

const Rename = z
  .strictObject({ kind: z.literal("rename"), use: z.string(), title: text })
  .superRefine((v, ctx) => {
    if (!(BUILTINS as readonly string[]).includes(v.use)) ctx.addIssue({ code: "custom", message: unknownBuiltin(v.use), path: ["use"] });
  })
  .transform((v): BuiltinRef => ({ use: v.use as BuiltinName, title: v.title.trim() }));

const Custom = z
  .strictObject({
    kind: z.literal("custom"),
    title: text,
    layout: z.enum(["list", "grid", "tags"]).optional(),
    columns: z.number().int().min(1).max(4).optional(),
    side: z.enum(["main", "aside"]).optional(),
    items: z.array(ItemU).min(1, "items needs at least one entry"),
  })
  .superRefine((s, ctx) => {
    const layout = s.layout ?? "list";
    const at = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", message, path });
    if (s.columns !== undefined && layout !== "grid") at(["columns"], '"columns" only works with layout: grid');
    const allowed = ALLOWED[layout];
    const first = s.items.find((it) => it.kind !== "bad")?.kind;
    const cls = (k: string) => (k === "check" ? "bullet" : k);
    s.items.forEach((it, j) => {
      if (it.kind === "bad") return;
      if (allowed.kinds.length && !allowed.kinds.includes(it.kind)) at(["items", j], `layout "${layout}" doesn't take a ${WHAT[it.kind]} here — it takes ${allowed.says}`);
      else if (layout !== "tags" && first && cls(it.kind) !== cls(first))
        at(["items", j], `items in one section must be the same kind — found ${WHAT[it.kind]} after ${WHAT[first]} (only bullets and checklist items can be mixed)`);
      if (it.kind !== "entry") return;
      if (it.date !== undefined && (it.start !== undefined || it.end !== undefined)) at(["items", j, "date"], `"date" can't be combined with "start"/"end" — use date for a single point in time, start/end for a range`);
      if (it.date === "present") at(["items", j, "date"], `"date" can't be "present" — use start/end for an ongoing range`);
      if (it.end !== undefined && it.start === undefined && it.date === undefined) at(["items", j, "end"], '"end" needs a "start"');
      if (it.start !== undefined && it.end !== undefined && it.date === undefined && endsBefore(it.start, it.end)) at(["items", j, "end"], `"end" (${it.end}) is before "start" (${it.start})`);
    });
  })
  .transform(
    (s): CustomSection => ({ title: s.title, layout: s.layout ?? "list", columns: s.columns ?? 2, side: s.side ?? "main", items: s.items.map(normalise) }),
  );

const SectionEntry = z.preprocess(tagSection, z.discriminatedUnion("kind", [Builtin, Rename, Custom, Bad.transform((v): never => v as never)]));

const Sections = z
  .array(SectionEntry)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((entry, i) => {
      const s = typeof entry === "string" ? entry : "use" in entry ? entry.use : undefined;
      if (!s) return;
      if (seen.has(s)) ctx.addIssue({ code: "custom", message: `duplicate section "${s}" — each built-in section can be listed once`, path: [i] });
      seen.add(s);
    });
  });

const relPath = (ext: RegExp, what: string) =>
  z.string().refine((p) => ext.test(p) && !/^([a-zA-Z]:)?[\\/]/.test(p) && !p.split(/[\\/]/).includes(".."), `expected a workspace-relative ${what} path (no leading / and no ..)`);

const Target = z.strictObject({
  company: str.optional(),
  role: str.optional(),
  jd: relPath(/\.md$/i, ".md").optional(),
  base: relPath(/\.ya?ml$/i, ".yaml").optional(),
});

const Letter = z.strictObject({
  recipient: z
    .union([text, z.array(text)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  place: text.optional(),
  date: isoDay.optional(),
  subject: text.optional(),
  salutation: text.optional(),
  body: z.array(text).min(1, "body needs at least one paragraph"),
  closing: text.optional(),
  signature: text.optional(),
});

export const Resume = z.object({
  meta: z
    .object({
      lang: z.enum(["en", "de"]).default("en"),
      theme: z.string().default("minimal"),
      accent: z
        .string()
        .regex(
          ACCENT,
          `accent must be a colour: "#2f54eb" / "#25e", rgb(47 84 235) or hsl(…) / oklch(…) with numbers only, or a colour name such as teal`,
        )
        .default("#2f54eb"),
      pages: z.number().int().positive().default(1),
      paper: z.enum(["a4", "letter"]).default("a4"),
      density: z.enum(["compact", "normal", "relaxed"]).default("normal"),
      colors: z.enum(["quiet", "accent"]).default("quiet"),
      filename: z
        .string()
        .superRefine((v, ctx) => {
          const problem = templateProblem(v);
          if (problem) ctx.addIssue({ code: "custom", message: problem });
        })
        .optional(),
      signature: Signature.optional(),
    })
    .default({ lang: "en", theme: "minimal", accent: "#2f54eb", pages: 1, paper: "a4", density: "normal", colors: "quiet" }),
  basics: z.object({
    name: z.string(),
    title: z.string(),
    location: z.string().optional(),
    address: lines(2, "address").optional(),
    availability: text.optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    workAuth: z.string().optional(),
    links: z.array(link).default([]),
    photo: z.string().optional(),
    summary: z.string().optional(),
  }),
  approach: z.array(z.object({ title: z.string(), text: z.string() })).default([]),
  experience: datedList(entry.extend({ company: z.string(), role: z.string(), url: z.string().optional() })),
  projects: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().optional(),
        tagline: z.string().optional(),
        bullets: z.array(z.string()).default([]),
        stack: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  skills: z.array(z.object({ group: z.string(), items: z.array(z.string()) })).default([]),
  education: datedList(entry.omit({ stack: true }).extend({ school: z.string(), degree: z.string() })),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string().optional(), date: date.optional() })).default([]),
  languages: z.array(z.object({ name: z.string(), level: z.string() })).default([]),
  sections: z.preprocess((v) => (v === null ? undefined : v), Sections.optional()),
  target: Target.optional(),
  letter: Letter.optional(),
});

export type Resume = z.infer<typeof Resume>;
