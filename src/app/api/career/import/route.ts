import { readCareerGate } from "@/lib/config/career-gate";
import { loadConfig } from "@/lib/config";
import { loadContact } from "@/lib/career/contact/store";
import { importKitYaml } from "@/lib/career/import/kit-yaml";
import { writeKitDraft } from "@/lib/career/import/store";
import { loadPreferences } from "@/lib/career/store/preferences";
import { logActionFailure } from "@/lib/logging/action-failure";
import { readBody } from "@/lib/stories/read-body";
import { enterUpload } from "@/lib/stories/upload-gate";
import { reply, refuse, failure } from "../tailor/reply";

export const dynamic = "force-dynamic";

/** Reads a resume-kit YAML upload without storing it: content becomes a review draft, contact and layout come back for confirmation. */
export async function POST(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  let release: (() => void) | null = null;
  try {
    const settings = loadConfig("career");
    release = enterUpload(settings.import.max_concurrent_uploads);
    if (release === null) return refuse("too_many");
    const body = await readBody(request, settings.import.max_file_bytes, settings.import.upload_timeout_seconds * 1000);
    if (body === null) return refuse("too_large");
    if (body === "timeout") return refuse("timeout");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); }
    catch { return refuse("kit_invalid"); }
    const parsed = importKitYaml(text);
    if (!parsed.ok) return refuse(parsed.code);
    const kit = parsed.result;
    const draftId = await writeKitDraft(kit, text);
    const contact = await loadContact();
    const preferences = await loadPreferences();
    return reply({
      ok: true, draftId, skipped: kit.skipped,
      contact: { incoming: kit.contact, current: contact.contact, baseHash: contact.baseHash },
      layout: { incoming: kit.layout, current: preferences.preferences, baseHash: preferences.baseHash },
    });
  } catch (error) {
    logActionFailure("importCareerKit", error);
    return failure(error);
  } finally { release?.(); }
}
