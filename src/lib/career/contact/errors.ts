export type CareerErrorCode =
  | "unresolved_claims"
  | "target_gone"
  | "proposal_invalid"
  | "proposal_write_failed"
  | "outbound_changed"
  | "doc_gone"
  | "job_gone"
  | "no_jd"
  | "document_invalid"
  | "document_missing"
  | "document_limit"
  | "preferences_invalid"
  | "image_invalid"
  | "image_too_large"
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
