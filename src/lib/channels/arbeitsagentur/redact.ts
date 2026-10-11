/**
 * Contact data is not stored. The API has no structured contact fields in the records
 * the channel reads, but job descriptions often end with "Ansprechpartner: Name, +49 ..." lines.
 * Best effort: e-mail addresses, phone numbers and explicit contact-person lines are removed.
 * A person's name that is not on such a line cannot be recognised and stays in the text.
 */

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** `+` or leading `0` followed by 8+ more digits with space / dash / slash / bracket separators (dots excluded: dates, prices). */
const PHONE = /(?<![\w.])(?:\+|00|0)\d[\d ()/\-–]{6,}\d(?![\w])/g;
/** Explicit contact-person labels, anywhere in a line: everything up to the end of the line goes ("Ansprechpartner: Name, Tel ..."). */
const CONTACT_LABEL =
  /(?:ansprechpartner(?:in)?(?:\/in)?|ansprechperson|kontaktperson|(?:dein|ihr)e?n? kontakt[^:\n]{0,40}|contact person)\s*:[^\n]*/gi;
/** Bare labels ("Kontakt: ...", "Recruiter: ...") only count at the start of a line, so running text is not cut. */
const CONTACT_LINE = /^[ \t*_>#-]*(?:kontakt|contact|recruiter(?:in)?)\s*:.*$/gim;

export const EMAIL_PLACEHOLDER = "[email removed]";
export const PHONE_PLACEHOLDER = "[phone removed]";
export const CONTACT_PLACEHOLDER = "[contact removed]";

function digitCount(text: string): number {
  return text.replace(/\D/g, "").length;
}

/** The text with e-mail addresses, phone numbers and contact-person lines replaced by placeholders. */
export function redactContacts(text: string): string {
  return text
    .replace(CONTACT_LABEL, CONTACT_PLACEHOLDER)
    .replace(CONTACT_LINE, CONTACT_PLACEHOLDER)
    .replace(EMAIL, EMAIL_PLACEHOLDER)
    .replace(PHONE, (match) => (digitCount(match) >= 9 ? PHONE_PLACEHOLDER : match));
}
