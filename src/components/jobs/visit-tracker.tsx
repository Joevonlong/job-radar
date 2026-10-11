"use client";

import { useEffect } from "react";

import { recordVisitAction } from "@/app/visit-actions";

/** Tells the server the user is looking at this page (once per page view); renders nothing. */
export function VisitTracker() {
  useEffect(() => {
    void recordVisitAction();
  }, []);
  return null;
}
