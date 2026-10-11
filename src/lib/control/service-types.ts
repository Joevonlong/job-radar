import type { ControlRequest } from "@/lib/db/repos/control-requests";

/** State of the control Server Actions as seen by `useActionState` (shared by the service and the client). */
export type ControlActionState =
  | { status: "idle" }
  | {
      status: "queued";
      request: number;
      kind: ControlRequest["kind"];
      /** An equal request was already waiting or running: nothing new was created. */
      existing: boolean;
      nonce: number;
    }
  | {
      status: "error";
      error: "invalidPayload" | "unknownChannel" | "nothingStale" | "nothingToScore" | "databaseUnavailable" | "tooSoon";
      nonce: number;
      /** `tooSoon`: seconds until the same request may be made again. */
      retryAfterSeconds?: number;
    };

export const IDLE_CONTROL_STATE: ControlActionState = { status: "idle" };

