import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { placeDictionary, placeLang } from "@/lib/market/geo";
import { placeCandidate, placeGeo } from "@/lib/market/places";

/**
 * The place picker's candidates (/me, setup): dictionary cities and countries whose name starts with `q`, named in the page's
 * language (`lang`, a locale), at most `ui.yaml: place_picker.candidates`. `kinds=city` lists cities only (the home city).
 * Worldwide and the regions are the page's own choices; this lists neither.
 */
export const dynamic = "force-dynamic";

const inputSchema = z.object({
  q: z.string().trim().max(100),
  lang: z.string().trim().max(20),
  kinds: z.enum(["city", "any"]),
});

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const input = inputSchema.safeParse({ q: params.get("q") ?? "", lang: params.get("lang") ?? "en", kinds: params.get("kinds") ?? "any" });
  if (!input.success || input.data.q === "") return Response.json({ candidates: [] }, { headers: { "Cache-Control": "no-store" } });
  try {
    const dictionary = placeDictionary();
    const geo = placeGeo(loadPipeline(), dictionary);
    const limit = loadConfig("ui").place_picker.candidates;
    const kinds = input.data.kinds === "city" ? (["city"] as const) : (["city", "country"] as const);
    const candidates = dictionary.searchPlaces(input.data.q, { lang: placeLang(input.data.lang), limit, kinds }).map((record) => placeCandidate(record, geo));
    return Response.json({ candidates }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[places] picker search failed:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ candidates: [] }, { status: 500 });
  }
}
