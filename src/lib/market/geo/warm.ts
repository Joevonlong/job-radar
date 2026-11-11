import { placeDictionary } from "./index";

/**
 * Reads the place dictionary once at the start of the web server (it takes a moment and blocks while it does), so the first
 * page or filter that needs it finds it loaded. A failure is logged and left to the first real use, which reports it there.
 */
export function warmPlaceDictionary(): void {
  try {
    const started = Date.now();
    const { meta } = placeDictionary();
    console.log(`[places] dictionary loaded: ${meta.counts.places} places in ${Date.now() - started} ms`);
  } catch (error) {
    console.error(`[places] could not read the place dictionary: ${error instanceof Error ? error.message : String(error)}`);
  }
}
