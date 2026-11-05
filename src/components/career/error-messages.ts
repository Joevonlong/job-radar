import type messages from "../../../messages/en.json";
import type { CareerErrorCode } from "@/lib/career/contact/errors";

type ErrorCode = CareerErrorCode | "stale" | "disabled" | "confirmation_required" | "request_failed" | "history_failed";
type ErrorMessageKey = `errors.${keyof typeof messages.career.errors}`;

const errorMessages = {
  profile_invalid: "errors.profileInvalid",
  contact_invalid: "errors.contactInvalid",
  unknown_id: "errors.unknownId",
  limits: "errors.limits",
  history_invalid: "errors.historyInvalid",
  version_missing: "errors.versionMissing",
  write_failed: "errors.writeFailed",
  stale: "errors.stale",
  disabled: "errors.disabled",
  confirmation_required: "errors.confirmationRequired",
  request_failed: "errors.requestFailed",
  history_failed: "errors.historyFailed",
} as const satisfies Record<ErrorCode, ErrorMessageKey>;

export function careerErrorMessageKey(code: string): ErrorMessageKey {
  if (Object.hasOwn(errorMessages, code)) return errorMessages[code as ErrorCode];
  return "errors.generic";
}
