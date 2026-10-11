/** Longest note text the detail page saves (longer input is rejected, not cut). */
export const NOTES_MAX_CHARS = 10_000;

/** Longest "next step" text the pipeline board saves (longer input is rejected, not cut). */
export const NEXT_ACTION_MAX_CHARS = 200;

/** Most interview rounds the pipeline board's counter goes up to. */
export const INTERVIEW_ROUNDS_MAX = 20;

/** A signal quote longer than this is shortened on the detail page until "expand" is clicked (about two lines). */
export const QUOTE_CLAMP_CHARS = 110;

/** How much of the sentence before the term the shortened quote keeps. */
export const QUOTE_CLAMP_LEAD_CHARS = 28;

/** Longest note a starred job keeps on the favorites page (longer input is rejected, not cut). */
export const FAVORITE_NOTE_MAX_CHARS = 200;
