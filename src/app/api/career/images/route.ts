import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import { deleteImage, saveImage } from "@/lib/career/store/images";
import { logActionFailure } from "@/lib/logging/action-failure";
import { readBody } from "@/lib/stories/read-body";
import { refuse, reply, storeFailure } from "../extract/reply";

export const dynamic = "force-dynamic";
const query = z.strictObject({ kind: z.enum(["photo", "signature"]) });

function imageQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.getAll("kind").length !== 1) return query.safeParse({});
  return query.safeParse(Object.fromEntries(params));
}

export async function POST(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const parsed = imageQuery(request);
    if (!parsed.success) return refuse("invalid");
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/octet-stream") return refuse("bad_type");
    const settings = loadConfig("career");
    const body = await readBody(request, settings.document.image_max_bytes, settings.import.upload_timeout_seconds * 1000);
    if (body === null) return refuse("too_large");
    if (body === "timeout") return refuse("invalid");
    await saveImage(parsed.data.kind, body);
    return reply({ ok: true });
  } catch (error) {
    logActionFailure("saveCareerImage", error);
    return storeFailure(error);
  }
}

export async function DELETE(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const parsed = imageQuery(request);
    if (!parsed.success) return refuse("invalid");
    await deleteImage(parsed.data.kind);
    return reply({ ok: true });
  } catch (error) {
    logActionFailure("deleteCareerImage", error);
    return storeFailure(error);
  }
}
