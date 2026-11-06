export type CareerErrorCode =
  | "profile_invalid"
  | "contact_invalid"
  | "unknown_id"
  | "limits"
  | "history_invalid"
  | "version_missing"
  | "write_failed"
  | "scrub_mismatch"
  | "contact_unreadable"
  | "draft_invalid"
  | "draft_missing";

/** Private file contents and parser exceptions never cross the storage boundary. */
export class CareerStoreError extends Error {
  constructor(readonly code: CareerErrorCode) {
    super(code);
    this.name = "CareerStoreError";
  }
}
