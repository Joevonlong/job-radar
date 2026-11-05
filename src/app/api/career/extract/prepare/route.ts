import { readCareerGate } from "@/lib/config/career-gate";
import { loadConfig } from "@/lib/config";
import { prepareCareerScrub } from "@/lib/career/contact/scrub";
import { logActionFailure } from "@/lib/logging/action-failure";
import { readPrepareInput } from "@/lib/outbound/prepare";
import { enterUpload } from "@/lib/stories/upload-gate";
import { neutralizeCareerSource } from "@/lib/career/ai/source";
import { reply, refuse, storeFailure } from "../reply";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  let release: (() => void) | null = null;
  try {
    const settings = loadConfig("career");
    release = enterUpload(settings.import.max_concurrent_uploads);
    if (release === null) return refuse("too_many");
    const result = await readPrepareInput(request, settings.import);
    if (!result.ok) return refuse(result.error);
    if (result.input.text.trim().length < settings.import.min_chars) return refuse("no_text");
    return reply({ ok: true, ...prepareCareerScrub(neutralizeCareerSource(result.input.text), { ...result.input, rules: settings.import }) });
  } catch (error) {
    logActionFailure("prepareCareerExtract", error);
    return storeFailure(error);
  } finally { release?.(); }
}
