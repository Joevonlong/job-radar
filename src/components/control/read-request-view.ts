import { controlRequestViewSchema, type ControlRequestView } from "@/lib/control/request-view-schema";

import type { ControlRequestRead } from "./use-control-request";

/**
 * One read of `/api/control/requests/<id>` for `useControlRequest`: 404 is a request that does not exist (or is not one a
 * button may poll), anything else that is not a valid view is read again on the next tick.
 */
export async function readRequestView(id: number): Promise<ControlRequestRead<ControlRequestView, ControlRequestView, ControlRequestView>> {
  try {
    const response = await fetch(`/api/control/requests/${id}`, { cache: "no-store" });
    if (response.status === 404) return { state: "missing" };
    if (!response.ok) return null;
    const parsed = controlRequestViewSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const view = parsed.data;
    if (view.status === "pending" || view.status === "running") return { state: "waiting", stage: view.status, queue: view.queue, waiting: view };
    return view.status === "done" ? { state: "done", done: view } : { state: "failed", failed: view };
  } catch {
    return null; // the next tick retries
  }
}
