"use client";

import { useEffect } from "react";

import { recordVisitAction as rawRecordVisitAction } from "@/app/visit-actions";
import { withActionFeedback } from "@/lib/actions/client";

const recordVisitAction = withActionFeedback(rawRecordVisitAction)(() => (undefined));

/** Tells the server the user is looking at this page (once per page view); renders nothing. */
export function VisitTracker() {
  useEffect(() => {
    void recordVisitAction();
  }, []);
  return null;
}
