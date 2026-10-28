"use client";

import { unstable_isUnrecognizedActionError } from "next/navigation";

export const ACTION_FAILURE_EVENT = "jobradar:action-failure";
export const ACTION_UPDATED_MARKER = "jobradar:action-updated";
export type ActionFailure = "updated" | "failed";

/** Shared by event handlers, effects and useActionState forms; a transport failure never escapes into a transition. */
export async function callAction<T, F>(action: () => Promise<T>, fallback: () => F): Promise<T | F> {
  try {
    return await action();
  } catch (error) {
    const kind: ActionFailure = unstable_isUnrecognizedActionError(error) ? "updated" : "failed";
    window.dispatchEvent(new CustomEvent<ActionFailure>(ACTION_FAILURE_EVENT, { detail: kind }));
    return fallback();
  }
}

/** Keep each action's argument and result types, with a caller-appropriate failure (or the previous form state). */
export function withActionFeedback<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>): (fallback: (...args: Args) => Result) => (...args: Args) => Promise<Result> {
  return (fallback) => (...args) => callAction(() => action(...args), () => fallback(...args));
}
