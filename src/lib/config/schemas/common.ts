import { CronPattern } from "croner";
import { z } from "zod";

/** Non-empty trimmed string. */
export const nonEmptyString = z.string().trim().min(1, "must not be empty");

/** Non-empty list of unique, non-empty strings. */
export const stringList = z
  .array(nonEmptyString)
  .refine((items) => new Set(items).size === items.length, "must not contain duplicates");

/** A regular expression written in YAML (matched case-insensitively, Unicode-aware). */
export const regexString = nonEmptyString.refine((value) => {
  try {
    new RegExp(value, "iu");
    return true;
  } catch {
    return false;
  }
}, "must be a valid regular expression");

/** Longest closed-posting phrase pattern. */
export const MAX_PHRASE_LENGTH = 200;
/** Most optional parts (`?`) in one phrase pattern (each can double the backtracking at a position). */
const MAX_PHRASE_OPTIONALS = 8;
/** Largest upper bound of a `{n,m}` repetition in a phrase pattern. */
const MAX_PHRASE_REPEAT = 5;

/**
 * Why a closed-posting phrase (`closed_posting.phrases`, `job_checks.closed_recheck.extra_phrases`) is not a safe pattern, or
 * null. The phrases run on up to 200,000 characters of an untrusted page, so they are kept to a subset that cannot backtrack
 * catastrophically: words, character classes, alternation, `\b`, optional parts (`?`, at most 8) and small `{n,m}` repetitions
 * (m <= 5); no unbounded repetition (`*`, `+`, `{n,}`) and no backreferences.
 */
export function unsafePhraseReason(source: string): string | null {
  if (source.length > MAX_PHRASE_LENGTH) return `longer than ${MAX_PHRASE_LENGTH} characters`;
  let optionals = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "\\") {
      const next = source[i + 1] ?? "";
      if (/[1-9k]/u.test(next)) return "backreferences are not allowed";
      i += 1;
      // \p{…}, \u{…}: skip the braces
      if (/[pPu]/u.test(next) && source[i + 1] === "{") i = Math.max(i, source.indexOf("}", i));
      continue;
    }
    if (char === "[") {
      // a character class: skip to its unescaped end
      for (i += 1; i < source.length && source[i] !== "]"; i += 1) if (source[i] === "\\") i += 1;
      continue;
    }
    if (char === "(" && source[i + 1] === "?") {
      i += 1; // a group modifier ((?:, (?=, (?<name>), not a quantifier
      continue;
    }
    if (char === "*" || char === "+") return "unbounded repetition (* or +) is not allowed";
    if (char === "?") {
      optionals += 1;
      if (optionals > MAX_PHRASE_OPTIONALS) return `more than ${MAX_PHRASE_OPTIONALS} optional parts (?)`;
      continue;
    }
    if (char === "{") {
      const repeat = /^\{(\d+)(?:(,)(\d*))?\}/u.exec(source.slice(i));
      if (!repeat) continue;
      if (repeat[2] && repeat[3] === "") return "unbounded repetition ({n,}) is not allowed";
      const max = Number(repeat[3] ?? repeat[1]);
      if (max > MAX_PHRASE_REPEAT) return `repetition above {${MAX_PHRASE_REPEAT}} is not allowed`;
      i += repeat[0].length - 1;
    }
  }
  return null;
}

/** A closed-posting phrase: a valid regular expression in the safe subset of `unsafePhraseReason`. */
export const phraseRegexString = regexString.superRefine((value, ctx) => {
  const reason = unsafePhraseReason(value);
  if (reason !== null) ctx.addIssue({ code: "custom", message: `must be a simple phrase pattern: ${reason}` });
});

/**
 * Why a user pattern has a nested quantifier (`(a+)+`, `(\w*)*`, `(x|y+){2,}`), or null. JavaScript regular expressions
 * have no time limit, and a repeated group that itself repeats is the usual cause of catastrophic backtracking. A simple
 * static check, not a complete one: a group whose body holds `*`, `+` or a `{n,m}` that allows more than one repetition
 * must not itself be followed by one of those. Escapes and character classes are skipped.
 */
export function nestedQuantifierReason(source: string): string | null {
  // one entry per open group: whether its body (or a group inside it) repeats
  const stack: boolean[] = [];
  let lastGroupRepeats = false;
  let afterGroup = false;
  const quantifierAt = (i: number): { length: number; many: boolean } | null => {
    const char = source[i];
    if (char === "*" || char === "+") return { length: 1, many: true };
    if (char === "{") {
      const repeat = /^\{(\d+)(?:(,)(\d*))?\}/u.exec(source.slice(i));
      if (!repeat) return null;
      const max = repeat[2] ? (repeat[3] === "" ? Infinity : Number(repeat[3])) : Number(repeat[1]);
      return { length: repeat[0].length, many: max > 1 };
    }
    return null;
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "\\") {
      const next = source[i + 1] ?? "";
      i += 1;
      if (/[pPuk]/u.test(next) && (source[i + 1] === "{" || source[i + 1] === "<")) i = Math.max(i, source.indexOf(source[i + 1] === "{" ? "}" : ">", i));
      afterGroup = false;
      continue;
    }
    if (char === "[") {
      for (i += 1; i < source.length && source[i] !== "]"; i += 1) if (source[i] === "\\") i += 1;
      afterGroup = false;
      continue;
    }
    if (char === "(") {
      stack.push(false);
      if (source[i + 1] === "?") i += 1; // (?: (?= (?<name> …: a group modifier, not a quantifier
      afterGroup = false;
      continue;
    }
    if (char === ")") {
      lastGroupRepeats = stack.pop() ?? false;
      // a group that repeats inside makes its parent's body repeat too
      if (lastGroupRepeats && stack.length > 0) stack[stack.length - 1] = true;
      afterGroup = true;
      continue;
    }
    const quantifier = quantifierAt(i);
    if (quantifier !== null) {
      if (afterGroup && lastGroupRepeats && quantifier.many) return `nested quantifier near position ${i}: a repeated group must not repeat inside`;
      if (quantifier.many && stack.length > 0) stack[stack.length - 1] = true;
      i += quantifier.length - 1;
      if (source[i + 1] === "?") i += 1; // lazy
      afterGroup = false;
      continue;
    }
    afterGroup = false;
  }
  return null;
}

/** Which kind of slow pattern `slowPatternReason` found. */
export type SlowPatternKind = "nested" | "unbounded" | "leading" | "alternation";

export interface SlowPattern {
  kind: SlowPatternKind;
  detail: string;
}

/** Characters an atom can start a match with: a set of (lower-case) characters, or "any". */
type FirstChars = "any" | string;

interface Atom {
  /** Can match many different characters (`.`, `\s`, `\w`, `\d`, a class, `\p{…}`): a run of it can be long on ordinary text. */
  broad: boolean;
  /** Matches almost anything (`.`, `\S`, `\W`, `\D`, a negated class). */
  dotLike: boolean;
  first: FirstChars;
  /** Nothing can be matched before it (the start of the pattern or of an alternative). */
  leading: boolean;
  /** `\s`, `\w` or `\d`: whitespace never overlaps the other two, so runs of them side by side split the text one way only. */
  cls?: "s" | "w" | "d";
  /** Where the atom starts in the pattern. */
  start?: number;
}

interface GroupFrame {
  /** The first characters of each alternative; null while an alternative has no atom yet. */
  firsts: Array<FirstChars | null>;
  broad: boolean;
}

const overlaps = (a: FirstChars | null, b: FirstChars | null): boolean => a === null || b === null || a === "any" || b === "any" || [...a].some((char) => b.includes(char));

function escapeAtom(next: string): Omit<Atom, "leading"> {
  if (next === "d") return { broad: true, dotLike: false, first: "0123456789", cls: "d" };
  if (next === "s") return { broad: true, dotLike: false, first: " \t\n\r\f\v", cls: "s" };
  if (next === "w") return { broad: true, dotLike: false, first: "any", cls: "w" };
  if (next === "p" || next === "P") return { broad: true, dotLike: false, first: "any" };
  if (next === "D" || next === "S" || next === "W") return { broad: true, dotLike: true, first: "any" };
  if (/[a-zA-Z0-9]/u.test(next)) return { broad: false, dotLike: false, first: "any" }; // \n, \t, \u…, \x…, \k<…>, \1
  return { broad: false, dotLike: false, first: next.toLowerCase() };
}

/**
 * Why a user pattern can be very slow on ordinary job text, or null. JavaScript regular expressions have no time limit, so the
 * usual shapes of catastrophic or quadratic backtracking are refused before a rule is saved (the filter also limits the time a
 * rule may take at run time, this is the early, readable answer):
 * - nested: a repeated group that repeats inside (`(a+)+`, see `nestedQuantifierReason`);
 * - unbounded: two or more unbounded runs of broad characters (`.*x.*y`, `\d+.*\d+`, `\w+\s*\w+`); a `+` run of `\s` right next
 *   to a `+` run of `\w` or `\d` counts as one (`\w+\s+\w+` splits a text one way only);
 * - leading: the pattern starts with an unbounded run of almost anything (`.*100%`), which is retried from every position;
 * - alternation: a repeated group whose alternatives can start with the same character (`(a|ab)+`, `(\w|-)+`).
 * A heuristic over the pattern's text: escapes and classes are read roughly, and bounded runs (`.{0,30}`, `\s?`) are fine.
 */
export function slowPatternReason(source: string): SlowPattern | null {
  const nested = nestedQuantifierReason(source);
  if (nested !== null) return { kind: "nested", detail: nested };
  const stack: GroupFrame[] = [{ firsts: [null], broad: false }];
  const unbounded: number[] = [];
  let last: (Atom & { group: GroupFrame | null }) | null = null;
  // the last unbounded run: its class, where its quantifier ends, its least count
  let lastRun: { cls: Atom["cls"]; end: number; min: number } | null = null;
  let atomStart = 0;
  const top = (): GroupFrame => stack[stack.length - 1]!;
  const isLeading = (): boolean => stack.every((frame) => frame.firsts[frame.firsts.length - 1] === null);
  const take = (atom: Omit<Atom, "leading">, group: GroupFrame | null = null): void => {
    const leading = isLeading();
    for (const frame of stack) {
      const at = frame.firsts.length - 1;
      if (frame.firsts[at] === null) frame.firsts[at] = atom.first;
      if (atom.broad) frame.broad = true;
    }
    last = { ...atom, leading, group, start: atomStart };
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    atomStart = i;
    if (char === "\\") {
      const next = source[i + 1] ?? "";
      i += 1;
      if (next === "b" || next === "B") {
        last = null;
        continue;
      }
      if (/[pPuk]/u.test(next) && (source[i + 1] === "{" || source[i + 1] === "<")) i = Math.max(i, source.indexOf(source[i + 1] === "{" ? "}" : ">", i));
      take(escapeAtom(next));
      continue;
    }
    if (char === "[") {
      const negated = source[i + 1] === "^";
      for (i += 1; i < source.length && source[i] !== "]"; i += 1) if (source[i] === "\\") i += 1;
      take({ broad: true, dotLike: negated, first: "any" });
      continue;
    }
    if (char === ".") {
      take({ broad: true, dotLike: true, first: "any" });
      continue;
    }
    if (char === "(") {
      // (?: (?= (?! (?<= (?<! (?<name>: the modifier is not an atom
      if (source[i + 1] === "?") {
        i += 1;
        if (source[i + 1] === "<" && source[i + 2] !== "=" && source[i + 2] !== "!") i = Math.max(i, source.indexOf(">", i));
        else i += source[i + 1] === "<" ? 2 : 1;
      }
      stack.push({ firsts: [null], broad: false });
      last = null;
      continue;
    }
    if (char === ")") {
      const frame = stack.length > 1 ? stack.pop()! : null;
      if (frame === null) continue;
      const first = frame.firsts.some((value) => value === null || value === "any") ? "any" : [...new Set(frame.firsts.join(""))].join("");
      // the group as one atom of its parent (its broad runs are already counted)
      const leading = isLeading();
      for (const parent of stack) {
        const at = parent.firsts.length - 1;
        if (parent.firsts[at] === null) parent.firsts[at] = first;
        if (frame.broad) parent.broad = true;
      }
      last = { broad: frame.broad, dotLike: false, first, leading, group: frame };
      continue;
    }
    if (char === "|") {
      top().firsts.push(null);
      last = null;
      continue;
    }
    if (char === "^" || char === "$") {
      last = null;
      continue;
    }
    let max: number | null = null;
    let min = 0;
    let length = 1;
    if (char === "*" || char === "+") {
      max = Infinity;
      min = char === "+" ? 1 : 0;
    } else if (char === "?") max = 1;
    else if (char === "{") {
      const repeat = /^\{(\d+)(?:(,)(\d*))?\}/u.exec(source.slice(i));
      if (repeat) {
        max = repeat[2] ? (repeat[3] === "" ? Infinity : Number(repeat[3])) : Number(repeat[1]);
        min = Number(repeat[1]);
        length = repeat[0].length;
      }
    }
    if (max === null) {
      take({ broad: false, dotLike: false, first: char.toLowerCase() });
      continue;
    }
    i += length - 1;
    if (source[i + 1] === "?") i += 1; // lazy
    const atom: (Atom & { group: GroupFrame | null }) | null = last;
    last = null;
    if (atom === null) continue;
    if (atom.group !== null && max > 1) {
      const { firsts } = atom.group;
      for (let a = 0; a < firsts.length; a += 1) {
        for (let b = a + 1; b < firsts.length; b += 1) {
          if (overlaps(firsts[a] ?? null, firsts[b] ?? null)) return { kind: "alternation", detail: `the alternatives of the repeated group before position ${i} can start alike` };
        }
      }
    }
    if (max === Infinity && atom.broad) {
      if (atom.leading && atom.dotLike) return { kind: "leading", detail: `starts with an unbounded run of any character (position ${i})` };
      const prior = lastRun;
      const splitsOneWay =
        prior !== null && atom.start === prior.end + 1 && prior.min >= 1 && min >= 1 && atom.cls !== undefined && prior.cls !== undefined && atom.cls !== prior.cls && (atom.cls === "s" || prior.cls === "s");
      if (!splitsOneWay) unbounded.push(i);
      lastRun = { cls: atom.cls, end: i, min };
    }
  }
  if (unbounded.length >= 2) return { kind: "unbounded", detail: `${unbounded.length} unbounded runs of broad characters (positions ${unbounded.join(", ")}); bound them, as in .{0,40}` };
  return null;
}

/** A named region of the market packs ("eu", "dach") or an ISO 3166-1 alpha-2 country code ("DE"). */
export const regionToken = z.union([
  z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, "must be a region id (lower case)"),
  z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code (upper case)"),
]);

/**
 * Remote scope shared by search.yaml and preferences.yaml: `none` (no remote jobs), `home_country` (remote jobs
 * that hire in the market's country), `worldwide`, or `{ region: [eu | ISO …] }` (remote jobs that hire in one of these
 * regions or countries). Before the market packs: `eu_hire_in_de` (= home_country for Germany) and `eu_any` (= `{ region: [eu] }`).
 */
export const remoteScope = z.union([
  z.enum(["none", "home_country", "worldwide"]),
  z.strictObject({ region: z.array(regionToken).min(1).refine((items) => new Set(items).size === items.length, "must not contain duplicates") }),
]);

/** "HH:MM" 24h clock time. */
export const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h)");

/** Number of fields in a schedule.yaml cron expression: minute hour day month weekday. */
const CRON_FIELD_COUNT = 5;

/**
 * Why a cron expression is not usable, or null when it is. Parsed with croner (the library that
 * schedules the cycles), so a value accepted here is guaranteed to schedule. Exactly 5 fields are
 * required: croner would also accept seconds/years, which would silently change the meaning.
 */
export function cronProblem(value: string): string | null {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) {
    return `must have exactly ${CRON_FIELD_COUNT} fields (minute hour day month weekday), got ${value.trim() === "" ? 0 : fields.length}`;
  }
  try {
    new CronPattern(fields.join(" "));
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid expression";
    return reason.replace(/^CronPattern:\s*/, "");
  }
}

export function isValidCron(value: string): boolean {
  return cronProblem(value) === null;
}

export const cronString = z.string().superRefine((value, ctx) => {
  const problem = cronProblem(value);
  if (problem !== null) ctx.addIssue({ code: "custom", message: `invalid cron expression: ${problem}` });
});

/** True when the runtime knows the IANA time zone. */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZone = z.string().refine(isValidTimeZone, "must be a valid IANA time zone");

export const nonNegativeNumber = z.number().min(0, "must be >= 0").finite();
export const positiveInt = z.number().int().positive();
export const nonNegativeInt = z.number().int().min(0, "must be >= 0");
export const score0to100 = z.number().min(0).max(100);
