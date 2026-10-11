import { ChannelError } from "../errors";
import { parseDate } from "../web/select";
import type { NormalizedPostingDraft } from "../types";
import { redactJobText } from "../web/redact";
import { payloadSchema, type StepstoneDetail, type StepstoneListItem } from "./schema";

/** Place names the board prints that are not places. */
const NOT_A_PLACE = /^(?:bundesweit|deutschlandweit(?:\s*\/\s*home-?office)?|home-?office|homeoffice|remote|germany|deutschland)$/i;

const COUNTRY_BY_NAME: Readonly<Record<string, string>> = { germany: "DE", deutschland: "DE", austria: "AT", "österreich": "AT", switzerland: "CH", schweiz: "CH" };

/**
 * The board's contract labels in words the pipeline's contract patterns (pipeline.yaml `contract`)
 * recognise: "permanent employment", "fixed-term", "Werkstudent", "freelance" ...
 */
const CONTRACT_TYPES: Readonly<Record<string, string>> = {
  "feste anstellung": "permanent employment",
  "befristeter vertrag": "fixed-term contract",
  "ausbildung, studium": "Ausbildung / dual study (apprenticeship)",
  "studentenjobs, werkstudent": "Werkstudent (working student)",
  "berufseinstieg/trainee": "trainee / entry level",
  "freie mitarbeit/projektmitarbeit": "freelance (freie Mitarbeit)",
};

const EMPLOYMENT_TYPES: Readonly<Record<string, string>> = {
  FULL_TIME: "full-time",
  PART_TIME: "part-time",
  CONTRACTOR: "freelance contractor",
  TEMPORARY: "temporary position",
  INTERN: "internship",
  VOLUNTEER: "volunteer",
  PER_DIEM: "per diem",
  OTHER: "other",
};

/** `unifiedSalary.period` (list, English) and `CESalary.period` (page, German) → period. */
const SALARY_PERIODS: Readonly<Record<string, "year" | "month" | "week" | "day" | "hour">> = {
  annually: "year",
  jahr: "year",
  monthly: "month",
  monat: "month",
  weekly: "week",
  woche: "week",
  daily: "day",
  tag: "day",
  hourly: "hour",
  stunde: "hour",
};

function clean(value: string | null | undefined): string | null {
  const text = value?.replace(/[\s ]+/g, " ").trim();
  return text ? text : null;
}

function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function countryCode(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_BY_NAME[trimmed.toLowerCase()] ?? null;
}

/**
 * Cities of the list's location text. "A, B, C" is a list of cities; "A, State, Country; B, State,
 * Country" (the long form some employers use) has one group per city, starting with the city.
 */
export function parseLocations(text: string | null | undefined, fallbackCountry: string | null): NormalizedPostingDraft["locations"] {
  const value = clean(text);
  if (!value) return [];
  const groups = value.includes(";") ? value.split(";") : null;
  const candidates = groups
    ? groups.map((group) => {
        const parts = group.split(",").map((part) => part.trim());
        const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
        return { city: parts[0] ?? "", country: countryCode(last) };
      })
    : value.split(",").map((part) => ({ city: part.trim(), country: null as string | null }));
  const seen = new Set<string>();
  const out: NormalizedPostingDraft["locations"] = [];
  for (const { city, country } of candidates) {
    if (city === "" || NOT_A_PLACE.test(city)) continue;
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: city, city, countryCode: country ?? fallbackCountry });
  }
  return out;
}

function workplace(list: StepstoneListItem, detail: StepstoneDetail | null): NormalizedPostingDraft["workplace"] {
  if (list.workFromHome === "1") return "remote";
  if (list.workFromHome === "2") return "hybrid";
  // the page's own wording, when the list does not say
  if (/home-?office möglich/i.test(detail?.jobAd?.metaData?.workType ?? "")) return "hybrid";
  return "unknown";
}

function contractHint(detail: StepstoneDetail | null): string | null {
  const hints: string[] = [];
  const contract = clean(detail?.jobAd?.metaData?.contractType);
  if (contract) hints.push(CONTRACT_TYPES[contract.toLowerCase()] ?? contract.toLowerCase());
  const employment = detail?.jsonLd?.employmentType;
  const types = Array.isArray(employment) ? employment : [employment];
  for (const type of types) {
    if (typeof type === "string") hints.push(EMPLOYMENT_TYPES[type] ?? type.toLowerCase().replace(/_/g, " "));
  }
  return hints.length > 0 ? [...new Set(hints)].join(", ") : null;
}

interface SalaryFigures {
  min: number | null;
  max: number | null;
  period: "year" | "month" | "week" | "day" | "hour" | null;
  currency: string;
}

function figures(min: number | null | undefined, max: number | null | undefined, period: string | null | undefined, currencyIso: string | null | undefined): SalaryFigures | null {
  const lo = min !== null && min !== undefined && min > 0 ? min : null;
  const hi = max !== null && max !== undefined && max > 0 ? max : null;
  if (lo === null && hi === null) return null;
  return {
    min: lo,
    max: hi,
    period: SALARY_PERIODS[(period ?? "").toLowerCase()] ?? null,
    currency: currencyIso && /^[A-Z]{3}$/.test(currencyIso) ? currencyIso : "EUR",
  };
}

function amountText(f: SalaryFigures): string {
  const amount = f.min !== null && f.max !== null && f.min !== f.max ? `${f.min}-${f.max}` : String(f.min ?? f.max);
  return `${amount} ${f.currency}${f.period ? `/${f.period}` : ""}`;
}

/**
 * The salary the posting itself states. StepStone also prints its own estimate (list `salaryType:
 * "Predicted"`, page `isPredicted`): that is not a fact of the posting (C3) and goes to `extra`.
 */
function salaries(list: StepstoneListItem, detail: StepstoneDetail | null): { stated: SalaryFigures | null; predicted: SalaryFigures | null } {
  const page = detail?.jobAd?.salary;
  const onList = list.unifiedSalary;
  const listFigures = onList ? figures(onList.min, onList.max, onList.period, onList.currencyIso) : null;
  const listPredicted = onList?.salaryType === undefined || onList?.salaryType === null ? true : /predict|estimat/i.test(onList.salaryType);
  const pageFigures = page ? figures(page.min, page.max, page.period, page.currencyIso) : null;
  const pagePredicted = page?.isPredicted !== false;

  if (pageFigures && !pagePredicted) return { stated: pageFigures, predicted: listFigures && listPredicted ? listFigures : null };
  if (listFigures && !listPredicted) return { stated: listFigures, predicted: pageFigures && pagePredicted ? pageFigures : null };
  return { stated: null, predicted: pageFigures ?? (listFigures && listPredicted ? listFigures : null) };
}

function omitEmpty(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null));
}

function descriptionOf(detail: StepstoneDetail | null): string {
  const fromLd = detail?.jsonLd?.description;
  if (typeof fromLd === "string" && fromLd.trim() !== "") return redactJobText(fromLd).trim();
  const sections = detail?.jobAd?.sections ?? [];
  return sections
    .map((s) => (s.title ? `${s.title}\n${s.text}` : s.text))
    .join("\n\n")
    .trim();
}

function organizationName(detail: StepstoneDetail | null): string | null {
  const org = detail?.jsonLd?.hiringOrganization;
  if (typeof org === "object" && org !== null && "name" in org && typeof org.name === "string") return clean(org.name);
  return null;
}

function firstAddressCountry(detail: StepstoneDetail | null): string | null {
  const place = detail?.jsonLd?.jobLocation;
  const first: unknown = Array.isArray(place) ? place[0] : place;
  if (typeof first !== "object" || first === null || !("address" in first)) return null;
  const address = first.address;
  if (typeof address !== "object" || address === null || !("addressCountry" in address)) return null;
  return typeof address.addressCountry === "string" ? countryCode(address.addressCountry) : null;
}

/** Convert a stored `{ url, list, detail }` payload into the normalized draft (C3: unstated facts stay unknown). */
export function parseStepstonePayload(payload: unknown): NormalizedPostingDraft {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `stepstone payload does not match the expected shape (${paths.join(", ")})`);
  }
  const { url, list, detail } = parsed.data;
  const ld = detail?.jsonLd ?? null;

  const title = clean(typeof ld?.title === "string" ? ld.title : null) ?? clean(list.title);
  if (!title) throw new ChannelError("parse", "stepstone posting has no title");
  const companyName = organizationName(detail) ?? clean(list.companyName);
  if (!companyName) throw new ChannelError("parse", "stepstone posting has no employer name");

  const pay = salaries(list, detail);
  const stated = pay.stated;
  const language = clean(detail?.jobAd?.language)?.toLowerCase();
  const postedAt = parseDate(typeof ld?.datePosted === "string" ? ld.datePosted : null) ?? parseDate(list.datePosted);
  const description = descriptionOf(detail);

  return {
    title,
    companyName,
    locations: parseLocations(list.location ?? detail?.jobAd?.metaData?.location, firstAddressCountry(detail)),
    workplace: workplace(list, detail),
    contractHint: contractHint(detail),
    seniorityHint: null,
    salaryText: stated ? amountText(stated) : null,
    salary:
      stated && stated.period && !(stated.min !== null && stated.max !== null && stated.min > stated.max)
        ? { min: stated.min, max: stated.max, currency: stated.currency, period: stated.period, raw: amountText(stated) }
        : null,
    description,
    descriptionLanguage: language && /^[a-z]{2}$/.test(language) ? language : "unknown",
    postedAt,
    applyUrl: httpUrlOrNull(url),
    sourceUrl: httpUrlOrNull(url),
    extra: omitEmpty({
      stepstoneId: list.id,
      harmonisedId: list.harmonisedId,
      section: list.section,
      listLocation: clean(list.location),
      workFromHomeFlag: list.workFromHome,
      workType: clean(detail?.jobAd?.metaData?.workType),
      industry: typeof ld?.industry === "string" ? ld.industry : undefined,
      validThrough: typeof ld?.validThrough === "string" ? ld.validThrough : undefined,
      directApply: typeof ld?.directApply === "boolean" ? ld.directApply : undefined,
      predictedSalary: pay.predicted ? { min: pay.predicted.min, max: pay.predicted.max, currency: pay.predicted.currency, period: pay.predicted.period } : undefined,
      hasDescription: description !== "",
    }),
  };
}
