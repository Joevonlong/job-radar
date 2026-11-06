import { NextResponse } from "next/server";
import { CareerStoreError } from "@/lib/career/contact/errors";
import { ConfigError } from "@/lib/config";
import type { Highlight } from "@/lib/outbound/scrub";
import type { ProjectionIssue } from "@/lib/career/render/to-resume";

const STATUS = { invalid: 400, too_large: 413, too_long: 413, bad_type: 415, unreadable: 422, too_complex: 422, no_text: 422, disabled: 409, review_again: 409, busy: 409, too_many: 429, config_error: 500, unavailable: 503, contact_invalid: 422, contact_unreadable: 503, profile_invalid: 422, render_invalid: 422, document_invalid: 422, document_missing: 404, document_limit: 409, preferences_invalid: 422, write_failed: 503 } as const;
export function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
export function refuse(error: keyof typeof STATUS, extra: { text?: string; highlights?: Highlight[]; issues?: ProjectionIssue[] } = {}): NextResponse {
  return reply({ ok: false, error, ...extra }, STATUS[error]);
}
export function storeFailure(error: unknown): NextResponse {
  if (error instanceof ConfigError) return refuse("config_error");
  if (error instanceof CareerStoreError) {
    if (error.code === "image_invalid") return refuse("bad_type");
    if (error.code === "image_too_large") return refuse("too_large");
    if (error.code in STATUS) return refuse(error.code as keyof typeof STATUS);
  }
  return refuse("unavailable");
}
