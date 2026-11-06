import { NextResponse } from "next/server";

import type { Highlight } from "@/lib/outbound/scrub";

const STATUS = {
  invalid: 400, too_large: 413, bad_type: 415, unreadable: 422, too_complex: 422, no_text: 422,
  disabled: 409, use_career: 409, busy: 409, too_many: 429, config_error: 500, unavailable: 503, review_again: 409, too_long: 422,
};
export function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
export function refuse(error: keyof typeof STATUS, details: { text?: string; highlights?: Highlight[] } = {}) {
  return reply({ ok: false, error, ...details }, STATUS[error]);
}
