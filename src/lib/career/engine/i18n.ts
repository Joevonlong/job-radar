import type { Resume } from "./schema";

export type Lang = Resume["meta"]["lang"];

const labels = {
  en: {
    summary: "Profile",
    approach: "AI Workflow",
    experience: "Experience",
    projects: "Projects",
    skills: "Skills",
    education: "Education",
    certifications: "Certifications",
    languages: "Languages",
    contact: "Contact",
    present: "Present",
  },
  de: {
    summary: "Profil",
    approach: "KI-Arbeitsweise",
    experience: "Berufserfahrung",
    projects: "Projekte",
    skills: "Kenntnisse",
    education: "Ausbildung",
    certifications: "Zertifikate",
    languages: "Sprachen",
    contact: "Kontakt",
    present: "heute",
  },
} as const;

export type Labels = (typeof labels)[Lang];

const words = {
  en: {
    available: "Available",
    letter: "Cover letter",
    salutation: "Dear Hiring Team,",
    closing: "Kind regards",
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  },
  de: {
    available: "Verfügbar",
    letter: "Anschreiben",
    salutation: "Sehr geehrte Damen und Herren,",
    closing: "Mit freundlichen Grüßen",
    months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
  },
} as const;

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const today = () => new Date().toLocaleDateString("sv-SE");

export const city = (s: string) =>
  s
    .split(",")[0]
    .replace(/^\s*(?:D-)?\d{4,5}\s+/, "")
    .trim();

export const homeCity = (b: Resume["basics"]) => (b.location ? city(b.location) : b.address ? city(b.address[b.address.length - 1]) : undefined) || undefined;

export function i18n(lang: Lang) {
  const t = labels[lang];
  const date = (d: string) => {
    if (d === "present") return t.present;
    const [y, m] = d.split("-");
    if (!m) return y;
    return lang === "de" ? `${m}/${y}` : `${MONTHS_EN[Number(m) - 1]} ${y}`;
  };
  const range = (start: string, end?: string) => (end ? `${date(start)} – ${date(end)}` : date(start));
  const w = words[lang];

  const day = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return lang === "de" ? `${d}. ${w.months[m - 1]} ${y}` : `${d} ${w.months[m - 1]} ${y}`;
  };

  const placeDate = (place: string | undefined, iso: string) => (place ? `${place}, ${day(iso)}` : day(iso));

  const availability = (s: string) => (s.trim().toLowerCase().startsWith(w.available.toLowerCase()) ? s.trim() : `${w.available}: ${s.trim()}`);
  return { t, w, date, range, day, placeDate, availability };
}
