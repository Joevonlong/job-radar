/**
 * Builds the offline place dictionary (`config/geo/places.json.gz`) from GeoNames dump files.
 *
 * Inputs (downloaded into a cache directory outside the repository, default `<os tmp>/job-radar-geonames`):
 * `cities15000.zip` (cities with a population of at least 15 000), `countryInfo.txt`, `admin1CodesASCII.txt` and
 * `alternateNamesV2.zip`. Kept per place: GeoNames id, canonical and ASCII name, country, first-level division,
 * population, the preferred English / German / Chinese name, the local name (first language of the country) and every
 * other spelling in those languages and the country's languages. Historic and colloquial names, abbreviations, codes,
 * links and one-character names are dropped so they cannot create false matches.
 *
 * The output is deterministic: the same input files give the same bytes (rows sorted by id, spellings sorted, gzip
 * header without a timestamp or OS byte). The header records when the files were fetched and their Last-Modified dates.
 *
 * Usage: pnpm geo:build [--cache <dir>] [--refresh] [--out <file>]
 * The data is GeoNames (https://www.geonames.org/), licensed CC BY 4.0.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

import { PLACE_DICTIONARY_FORMAT, type PlaceDictionaryFile } from "../../src/lib/market/geo/format";

const BASE_URL = "https://download.geonames.org/export/dump/";
const FILES = ["cities15000.zip", "countryInfo.txt", "admin1CodesASCII.txt", "alternateNamesV2.zip"] as const;
const DISPLAY_LANGS = ["en", "de", "zh"] as const;
const SKIPPED_LANGS = new Set(["", "abbr", "link", "post", "iata", "icao", "faac", "tcid", "unlc", "wkdt", "phon", "piny"]);

interface FetchRecord {
  fetched: string;
  lastModified: Record<string, string>;
}

interface AltName {
  lang: string;
  simplified: boolean;
  name: string;
  preferred: boolean;
  short: boolean;
}

interface Args {
  cache: string;
  refresh: boolean;
  out: string;
}

/** Reads the command line; unknown flags stop the build. */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    cache: path.join(os.tmpdir(), "job-radar-geonames"),
    refresh: false,
    out: path.resolve(import.meta.dirname, "..", "..", "config", "geo", "places.json.gz"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--refresh") args.refresh = true;
    else if (flag === "--cache" && value !== undefined) {
      args.cache = path.resolve(value);
      i += 1;
    } else if (flag === "--out" && value !== undefined) {
      args.out = path.resolve(value);
      i += 1;
    } else throw new Error(`Unknown argument: ${flag ?? ""}. Usage: pnpm geo:build [--cache <dir>] [--refresh] [--out <file>]`);
  }
  return args;
}

/** Downloads the GeoNames files into the cache unless they are there already (or `--refresh`). */
async function fetchFiles(cache: string, refresh: boolean): Promise<FetchRecord> {
  fs.mkdirSync(cache, { recursive: true });
  const recordFile = path.join(cache, "fetched.json");
  const complete = FILES.every((file) => fs.existsSync(path.join(cache, file))) && fs.existsSync(recordFile);
  if (complete && !refresh) {
    return JSON.parse(fs.readFileSync(recordFile, "utf8")) as FetchRecord;
  }
  const lastModified: Record<string, string> = {};
  for (const file of FILES) {
    console.log(`downloading ${BASE_URL}${file}`);
    const response = await fetch(`${BASE_URL}${file}`);
    if (!response.ok || response.body === null) throw new Error(`GeoNames download failed: ${file} (HTTP ${response.status})`);
    const modified = response.headers.get("last-modified");
    lastModified[file] = modified === null ? "unknown" : new Date(modified).toISOString().slice(0, 10);
    const target = path.join(cache, file);
    const out = fs.createWriteStream(`${target}.part`);
    await pipeline(async function* () {
      for await (const chunk of response.body ?? []) yield chunk;
    }, out);
    fs.renameSync(`${target}.part`, target);
  }
  const record: FetchRecord = { fetched: new Date().toISOString().slice(0, 10), lastModified };
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Streams the tab-separated lines of a plain file or of one member of a zip archive (through `unzip -p`). */
async function* lines(file: string, member?: string): AsyncGenerator<string[]> {
  const child = member === undefined ? null : spawn("unzip", ["-p", file, member], { stdio: ["ignore", "pipe", "inherit"] });
  const input = child === null ? fs.createReadStream(file) : child.stdout;
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    if (line === "" || line.startsWith("#")) continue;
    yield line.split("\t");
  }
  if (child !== null) {
    const code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.on("close", resolve);
    });
    if (code !== 0) throw new Error(`unzip -p ${file} ${member ?? ""} exited with ${String(code)}`);
  }
}

/** Collapses the GeoNames language tag to the one the dictionary uses (`zh-CN`, `zh-Hans`, `zh-SG` → `zh`). */
function normaliseLang(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower === "zh" || lower === "zh-cn" || lower === "zh-hans" || lower === "zh-sg") return "zh";
  if (lower.startsWith("zh-")) return "zh-hant";
  return lower.split("-")[0] ?? lower;
}

/** A spelling is kept when it is at least two characters and carries no digits (codes, postcodes). */
function usableSpelling(name: string): boolean {
  return [...name.trim()].length >= 2 && !/\d/.test(name);
}

/**
 * The preferred name in a language: a preferred non-short name, then any preferred, then the first full name. For
 * Chinese, names tagged as Simplified (`zh-CN`, `zh-Hans`, `zh-SG`) come before plain `zh`, which GeoNames also uses for
 * Traditional spellings.
 */
function pickName(names: AltName[], lang: string): string | null {
  const all = names.filter((n) => n.lang === lang);
  const simplified = all.filter((n) => n.simplified);
  const inLang = simplified.length > 0 ? simplified : all;
  const choice =
    inLang.find((n) => n.preferred && !n.short) ?? inLang.find((n) => n.preferred) ?? inLang.find((n) => !n.short) ?? inLang[0];
  return choice?.name ?? null;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Writes gzip bytes that depend only on the content: no timestamp, OS byte set to "unknown". */
function deterministicGzip(text: string): Buffer {
  const bytes = zlib.gzipSync(Buffer.from(text, "utf8"), { level: 9 });
  bytes.writeUInt32LE(0, 4);
  bytes[9] = 255;
  return bytes;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const record = await fetchFiles(args.cache, args.refresh);
  const file = (name: (typeof FILES)[number]): string => path.join(args.cache, name);

  const countries = new Map<string, { id: number; name: string; population: number; langs: string[] }>();
  for await (const cols of lines(file("countryInfo.txt"))) {
    const [iso, , , , name, , , population, , , , , , , , languages, geonameId] = cols;
    if (iso === undefined || name === undefined || geonameId === undefined || geonameId === "") continue;
    const langs = sortedUnique((languages ?? "").split(",").filter((l) => l !== "").map(normaliseLang));
    const firstLang = normaliseLang((languages ?? "").split(",")[0] ?? "");
    countries.set(iso, { id: Number(geonameId), name, population: Number(population ?? 0), langs: [firstLang, ...langs.filter((l) => l !== firstLang)] });
  }

  const admin1 = new Map<string, { id: number; name: string }>();
  for await (const [code, name, , geonameId] of lines(file("admin1CodesASCII.txt"))) {
    if (code === undefined || name === undefined || geonameId === undefined) continue;
    admin1.set(code, { id: Number(geonameId), name });
  }

  interface CityRow {
    id: number;
    name: string;
    ascii: string;
    country: string;
    admin1: string | null;
    population: number;
  }
  const cities: CityRow[] = [];
  for await (const cols of lines(file("cities15000.zip"), "cities15000.txt")) {
    const [id, name, ascii, , , , featureClass, , country, , admin1Code, , , , population] = cols;
    if (id === undefined || name === undefined || country === undefined || featureClass !== "P") continue;
    if (!countries.has(country)) continue;
    const a1 = admin1Code !== undefined && admin1Code !== "" && admin1.has(`${country}.${admin1Code}`) ? `${country}.${admin1Code}` : null;
    cities.push({ id: Number(id), name, ascii: ascii ?? name, country, admin1: a1, population: Number(population ?? 0) });
  }

  const wanted = new Map<number, Set<string>>();
  const want = (id: number, langs: string[]): void => {
    wanted.set(id, new Set([...DISPLAY_LANGS, "zh-hant", ...langs]));
  };
  for (const c of countries.values()) want(c.id, c.langs);
  for (const a of admin1.values()) want(a.id, []);
  for (const city of cities) want(city.id, countries.get(city.country)?.langs ?? []);

  const alt = new Map<number, AltName[]>();
  for await (const cols of lines(file("alternateNamesV2.zip"), "alternateNamesV2.txt")) {
    const [, idText, isoLang, name, preferred, short, colloquial, historic, , to] = cols;
    if (idText === undefined || name === undefined || isoLang === undefined) continue;
    const id = Number(idText);
    const langs = wanted.get(id);
    if (langs === undefined || SKIPPED_LANGS.has(isoLang)) continue;
    if (colloquial === "1" || historic === "1" || (to ?? "") !== "") continue;
    const lang = normaliseLang(isoLang);
    if (!langs.has(lang) || !usableSpelling(name)) continue;
    const list = alt.get(id) ?? [];
    list.push({ lang, simplified: /^zh-(cn|hans|sg)$/i.test(isoLang), name: name.trim(), preferred: preferred === "1", short: short === "1" });
    alt.set(id, list);
  }

  const localised = (id: number, fallback: string, localLang: string | null) => {
    const names = alt.get(id) ?? [];
    const en = pickName(names, "en") ?? fallback;
    const de = pickName(names, "de");
    const zh = pickName(names, "zh");
    const local = localLang === null ? null : pickName(names, localLang);
    return { names, en, de: de === en ? null : de, zh, local: local === en ? null : local };
  };

  const admin1Codes = sortedUnique(cities.flatMap((c) => (c.admin1 === null ? [] : [c.admin1])));
  const admin1Rows: PlaceDictionaryFile["admin1"] = admin1Codes.map((code) => {
    const entry = admin1.get(code);
    if (entry === undefined) throw new Error(`admin1 code vanished: ${code}`);
    const n = localised(entry.id, entry.name, null);
    return [code, n.en, n.de, n.zh];
  });

  const countryRows: PlaceDictionaryFile["countries"] = [...countries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([iso, c]) => {
      const n = localised(c.id, c.name, c.langs[0] ?? null);
      const shown = new Set([c.name, n.en, n.de, n.zh, n.local]);
      const spellings = sortedUnique(n.names.map((x) => x.name).filter((s) => !shown.has(s)));
      return [iso, c.id, n.en, n.de, n.zh, n.local, c.langs[0] ?? "", c.population, spellings];
    });

  const placeRows: PlaceDictionaryFile["places"] = cities
    .sort((a, b) => a.id - b.id)
    .map((city) => {
      const localLang = countries.get(city.country)?.langs[0] ?? null;
      const n = localised(city.id, city.name, localLang);
      const shown = new Set([city.name, city.ascii, n.en, n.de, n.zh, n.local]);
      const spellings = sortedUnique(n.names.map((x) => x.name).filter((s) => !shown.has(s)));
      return [
        city.id,
        city.name,
        city.ascii === city.name ? null : city.ascii,
        city.country,
        city.admin1,
        city.population,
        n.en === city.name ? null : n.en,
        n.de,
        n.zh,
        n.local,
        spellings,
      ];
    });

  const withZh = placeRows.filter((row) => row[8] !== null).length;
  const output: PlaceDictionaryFile = {
    format: PLACE_DICTIONARY_FORMAT,
    source: "GeoNames (https://www.geonames.org/), cities15000 and all countries",
    licence: "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
    fetched: record.fetched,
    lastModified: Object.fromEntries(Object.entries(record.lastModified).sort(([a], [b]) => (a < b ? -1 : 1))),
    counts: { places: placeRows.length, countries: countryRows.length, admin1: admin1Rows.length, placesWithZh: withZh },
    admin1: admin1Rows,
    countries: countryRows,
    places: placeRows,
  };
  const json = `${JSON.stringify(output)}\n`;
  const gz = deterministicGzip(json);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, gz);
  console.log(
    `wrote ${path.relative(process.cwd(), args.out)}: ${placeRows.length} places, ${countryRows.length} countries, ` +
      `${admin1Rows.length} first-level divisions, ${withZh} places with a Chinese name; ` +
      `${(json.length / 1e6).toFixed(1)} MB JSON, ${(gz.length / 1e6).toFixed(2)} MB gzip`,
  );
}

await main();
