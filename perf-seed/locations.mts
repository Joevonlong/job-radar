// Realistic location generator: draft locations as channels deliver them, run through the real ingest normalization.
import { loadPipeline } from "../src/lib/market";
import { normalizeDraftLocations, type DraftLocation } from "../src/lib/pipeline/geography";

const p = loadPipeline();
let seed = 42;
export const rnd = (): number => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
// Zipf-ish pick: index ~ floor(n * u^2.2)
const zipf = <T,>(a: readonly T[]): T => a[Math.min(a.length - 1, Math.floor(a.length * Math.pow(rnd(), 2.2)))]!;

const muc = ["Garching", "Unterföhring", "Ismaning", "Oberhaching", "Unterschleißheim", "Planegg", "Martinsried", "Freising", "Ottobrunn", "Taufkirchen", "Poing", "Aschheim", "Feldkirchen", "Neubiberg", "Hallbergmoos", "Eching", "Grünwald", "Pullach", "Dachau", "Germering", "Starnberg", "Erding"];
const ber = ["Potsdam", "Schönefeld", "Teltow", "Hennigsdorf", "Falkensee", "Ludwigsfelde", "Wildau"];
const deBig = ["Hamburg", "Frankfurt", "Köln", "Cologne", "Stuttgart", "Düsseldorf", "Leipzig", "Dresden", "Hannover", "Nürnberg", "Nuremberg", "Bremen", "Dortmund", "Essen", "Bonn", "Karlsruhe", "Aachen", "Darmstadt", "Heidelberg", "Freiburg", "Münster", "Mannheim", "Augsburg", "Wolfsburg", "Ingolstadt", "Jena", "Kiel"];
const deSmall = Array.from({ length: 600 }, (_, i) => ["Walldorf", "Bochum", "Regensburg", "Würzburg", "Erlangen", "Ulm", "Paderborn", "Göttingen", "Kassel", "Wiesbaden", "Mainz", "Gütersloh", "Herzogenaurach", "Rosenheim", "Landshut", "Passau", "Bamberg", "Bayreuth", "Fürth", "Trier"][i % 20]! + (i < 20 ? "" : ` ${["am Main", "an der Donau", "Nord", "Süd", "West", "Ost", "bei Ulm", "im Allgäu", "in Oberbayern", "(Westf.)"][Math.floor(i / 20) % 10]}${i >= 200 ? ` ${Math.floor(i / 200)}` : ""}`));
const foreign = ["Amsterdam, North Holland, Netherlands", "London, England, United Kingdom", "Zürich, Switzerland", "Vienna, Austria", "Paris, Île-de-France, France", "Dublin, Ireland", "Warsaw, Poland", "Barcelona, Spain", "Lisbon, Portugal", "New York, NY", "San Francisco, CA", "Austin, TX", "Remote - USA", "Toronto, Ontario, Canada", "Bangalore, India", "Prague, Czechia", "Stockholm, Sweden", "Copenhagen, Denmark"];
const states: Record<string, string> = { München: "Bavaria", Berlin: "Berlin" };

function liLabel(city: string, state: string): string { return pick([`${city}, ${state}, Germany`, `${city}, ${state}, Germany`, `${city}, Germany`, `Greater ${city} Metropolitan Area`, `${city} Metropolitan Area`, city]); }
function one(): DraftLocation {
  const u = rnd();
  if (u < 0.30) { const c = pick(["Munich", "München", "Munich"]); return rnd() < 0.5 ? { label: liLabel(c, "Bavaria"), city: null, countryCode: null } : { label: c, city: c, countryCode: "DE" }; }
  if (u < 0.38) { const t = zipf(muc); return { label: pick([`${t}, Bavaria, Germany`, `${t} bei München`, t]), city: rnd() < 0.5 ? t : null, countryCode: rnd() < 0.5 ? "DE" : null }; }
  if (u < 0.63) return rnd() < 0.5 ? { label: liLabel("Berlin", "Berlin"), city: null, countryCode: null } : { label: pick(["Berlin", "Berlin, Germany", "Berlin, DE"]), city: "Berlin", countryCode: "DE" };
  if (u < 0.66) { const t = zipf(ber); return { label: `${t}, Brandenburg, Germany`, city: null, countryCode: null }; }
  if (u < 0.80) { const c = zipf(deBig); return { label: pick([`${c}, Germany`, `${c}, ${pick(["Hesse", "Hamburg", "North Rhine-Westphalia", "Baden-Württemberg", "Saxony"])}, Germany`, c]), city: rnd() < 0.5 ? c : null, countryCode: rnd() < 0.6 ? "DE" : null }; }
  if (u < 0.88) { const c = zipf(deSmall); return { label: pick([`${c}, Deutschland`, `${c}, Germany`, `${c}, Bavaria, Germany`]), city: rnd() < 0.4 ? c : null, countryCode: rnd() < 0.5 ? "DE" : null }; }
  if (u < 0.95) return { label: pick(["Germany", "Deutschland", "Remote", "Remote, Germany", "Home Office", "Bundesweit", "Hybrid", "Multiple locations"]), city: null, countryCode: null };
  return { label: zipf(foreign), city: null, countryCode: null };
}
export interface Loc { label: string; city: string | null; countryCode: string | null; isPrimary: boolean }
export function jobLocations(): Loc[] {
  const n = rnd() < 0.85 ? 1 : 2 + Math.floor(rnd() * 4);
  return normalizeDraftLocations(Array.from({ length: n }, one), p.market) as Loc[];
}
void states;
