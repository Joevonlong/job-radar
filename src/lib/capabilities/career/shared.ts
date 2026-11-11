import { z } from "zod";
import { CareerStoreError } from "@/lib/career/contact/errors";
import { careerOutboundScrubber } from "@/lib/career/contact/scrub";
import { documentIdSchema } from "@/lib/career/schema/document";
import { versionIdSchema } from "@/lib/career/store/history";
import { loadDocument, readDocumentVersion } from "@/lib/career/store/documents";
import { ToolFailure, type McpContext } from "@/lib/mcp/context";
import { shortFieldCleaner } from "@/lib/mcp/guard";
import { readTextCleaner } from "@/lib/mcp/read-guard";
import { readTraps } from "@/lib/mcp/tools/shared";
import type { Capability } from "../types";

export const careerAvailability: NonNullable<Capability["availability"]> = {
  available: (ctx) => ctx.features?.careerEnabled() === true,
  category: "disabled",
  message: "errors.careerDisabled",
};
export const documentInput = (ctx: Pick<McpContext, "text">) => z.strictObject({
  id: documentIdSchema.describe(ctx.text("params.careerDocumentId")),
  version: versionIdSchema.optional().describe(ctx.text("params.careerVersion")),
});

export async function careerRead<T>(ctx: Pick<McpContext, "text">, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof CareerStoreError && ["document_missing", "version_missing"].includes(error.code)) {
      throw new ToolFailure("not_found", ctx.text("errors.careerNotFound"));
    }
    throw new ToolFailure("unavailable", ctx.text("errors.personalUnavailable"));
  }
}

export function careerCleaner(ctx: Pick<McpContext, "traps" | "text">) {
  const scrub = careerOutboundScrubber();
  const clean = shortFieldCleaner(readTraps(ctx));
  const redactPaths = readTextCleaner(null, ctx.text("notice.redacted"));
  return (text: string) => redactPaths(scrub(clean(text)));
}

export async function storedDocument(args: { id: string; version?: string }) {
  if (args.version) return { document: await readDocumentVersion(args.id, args.version), baseHash: null };
  return loadDocument(args.id);
}
