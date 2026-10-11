import { ChannelError } from "../errors";
import type { NormalizedPostingDraft } from "../types";
import { redactContacts } from "./redact";
import { payloadSchema, type BaDetail, type BaLocation, type BaSearchItem } from "./schema";

/** Public page of a posting on arbeitsagentur.de; `{refnr}` is appended. */
export const JOB_PAGE_URL = "https://www.arbeitsagentur.de/jobsuche/jobdetail";

type Posting = BaSearchItem & Partial<BaDetail>;

/** `land` as the API spells it (upper case, umlauts transliterated) → ISO 3166-1 alpha-2. */
const COUNTRY_CODES: Readonly<Record<string, string>> = {
  DEUTSCHLAND: "DE",
  OESTERREICH: "AT",
  SCHWEIZ: "CH",
  LUXEMBURG: "LU",
  NIEDERLANDE: "NL",
  BELGIEN: "BE",
  FRANKREICH: "FR",
  POLEN: "PL",
  TSCHECHIEN: "CZ",
  DAENEMARK: "DK",
  ITALIEN: "IT",
  SPANIEN: "ES",
};

/** Salary kinds the API names → period. Other kinds keep the text only (C3: no guessing). */
const SALARY_PERIODS: Readonly<Record<string, "year" | "month" | "week" | "day" | "hour">> = {
  JAHRESGEHALT: "year",
  MONATSGEHALT: "month",
  WOCHENGEHALT: "week",
  TAGESGEHALT: "day",
  STUNDENLOHN: "hour",
};

const OFFER_TYPE_HINTS: Readonly<Record<string, string>> = {
  PRAKTIKUM_TRAINEE: "internship/trainee",
  AUSBILDUNG: "apprenticeship",
  SELBSTAENDIGKEIT: "self-employed",
};

function clean(value: string | undefined): string | undefined {
  const text = value?.replace(/[\s ]+/g, " ").trim();
  return text ? text : undefined;
}

export function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function httpUrlOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function countryCode(land: string | undefined): string | null {
  if (!land) return null;
  const key = land
    .toUpperCase()
    .replace(/Ä/g, "AE")
    .replace(/Ö/g, "OE")
    .replace(/Ü/g, "UE")
    .replace(/ß/g, "SS")
    .trim();
  return COUNTRY_CODES[key] ?? null;
}

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function mapLocations(locations: readonly BaLocation[]): NormalizedPostingDraft["locations"] {
  const seen = new Set<string>();
  const out: NormalizedPostingDraft["locations"] = [];
  for (const location of locations) {
    const address = location.adresse;
    const city = clean(address?.ort) ?? null;
    const region = clean(address?.region);
    const label = city ?? (region ? titleCase(region) : undefined);
    if (!label) continue;
    const code = countryCode(address?.land);
    const key = `${label}|${code ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, city, countryCode: code });
  }
  return out;
}

function workplace(p: Posting): NormalizedPostingDraft["workplace"] {
  if (p.homeofficemoeglich === undefined) return "unknown";
  if (!p.homeofficemoeglich) return "onsite";
  return p.homeofficeprozent === 100 ? "remote" : "hybrid";
}

function contractHint(p: Posting): string | null {
  const hints: string[] = [];
  if (p.stellenangebotsart && p.stellenangebotsart !== "ARBEIT") {
    hints.push(OFFER_TYPE_HINTS[p.stellenangebotsart] ?? p.stellenangebotsart.toLowerCase().replace(/_/g, " "));
  }
  if (p.vertragsdauer === "UNBEFRISTET") hints.push("permanent");
  else if (p.vertragsdauer === "BEFRISTET") hints.push("fixed-term");
  if (p.arbeitszeitVollzeit) hints.push("full-time");
  if (p.arbeitszeitTeilzeitAbend || p.arbeitszeitTeilzeitNachmittag || p.arbeitszeitTeilzeitVormittag || p.arbeitszeitTeilzeitFlexibel) {
    hints.push("part-time");
  }
  if (p.arbeitszeitSchichtNachtWochenende) hints.push("shift work");
  if (p.istGeringfuegigeBeschaeftigung) hints.push("mini-job");
  return hints.length > 0 ? hints.join(", ") : null;
}

const positive = (n: number | undefined): number | null => (n !== undefined && n > 0 ? n : null);

function salary(p: Posting): { text: string | null; salary: NormalizedPostingDraft["salary"] } {
  const fixed = positive(p.festgehalt);
  const from = positive(p.gehaltsspanneVon);
  const to = positive(p.gehaltsspanneBis);
  const min = fixed ?? from;
  const max = fixed ?? to;
  if (min === null && max === null) return { text: null, salary: null };
  const period = p.verguetungsangabe ? SALARY_PERIODS[p.verguetungsangabe] : undefined;
  const amount = min !== null && max !== null && min !== max ? `${min}-${max}` : String(min ?? max);
  const text = `${amount} EUR${period ? `/${period}` : ""}`;
  if (!period || (min !== null && max !== null && min > max)) return { text, salary: null };
  return { text, salary: { min, max, currency: "EUR", period, raw: text } };
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

/** Convert a stored `{ list, detail }` payload into the normalized draft (C3: unstated facts stay unknown). */
export function parseArbeitsagenturPayload(payload: unknown): NormalizedPostingDraft {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `arbeitsagentur payload does not match the expected shape (${paths.join(", ")})`);
  }
  const { list, detail } = parsed.data;
  // the detail record is the fuller one; the list item fills what it leaves out
  const p: Posting = { ...list, ...(detail ? Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined)) : {}) };

  const title = clean(p.stellenangebotsTitel);
  if (!title) throw new ChannelError("parse", "arbeitsagentur posting has no title");
  const companyName = clean(p.firma);
  if (!companyName) throw new ChannelError("parse", "arbeitsagentur posting has no employer name");

  const sourceUrl = `${JOB_PAGE_URL}/${encodeURIComponent(list.referenznummer)}`;
  const pay = salary(p);
  const description = detail?.stellenangebotsBeschreibung ? redactContacts(detail.stellenangebotsBeschreibung).trim() : "";
  const agency =
    p.istArbeitnehmerUeberlassung === undefined && p.istPrivateArbeitsvermittlung === undefined
      ? undefined
      : p.istArbeitnehmerUeberlassung === true || p.istPrivateArbeitsvermittlung === true;

  return {
    title,
    companyName,
    locations: mapLocations(p.stellenlokationen ?? []),
    workplace: workplace(p),
    contractHint: contractHint(p),
    seniorityHint: null,
    salaryText: pay.text,
    salary: pay.salary,
    description,
    postedAt: toDate(p.datumErsteVeroeffentlichung) ?? toDate(p.veroeffentlichungszeitraum?.von),
    applyUrl: httpUrlOrNull(p.externeURL) ?? sourceUrl,
    sourceUrl,
    ...(agency === undefined ? {} : { isAgency: agency }),
    extra: omitUndefined({
      referenceNumber: list.referenznummer,
      offerType: p.stellenangebotsart,
      contractDuration: p.vertragsdauer,
      occupation: clean(p.hauptberuf),
      homeOfficeType: p.homeofficetyp,
      homeOfficePercent: p.homeofficeprozent,
      distanceKm: list.entfernung,
      lastModified: p.aenderungsdatum,
      hasExternalApplyUrl: httpUrlOrNull(p.externeURL) !== null,
      hasDescription: description !== "",
    }),
  };
}
