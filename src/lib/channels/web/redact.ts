import { CONTACT_PLACEHOLDER, EMAIL_PLACEHOLDER, PHONE_PLACEHOLDER, redactContacts } from "../arbeitsagentur/redact";

/**
 * Contact data is not stored (the same rule as for the Arbeitsagentur records, applied to the job boards' descriptions). On top of
 * `redactContacts` (e-mail addresses, phone numbers, "Ansprechpartner: ..." lines):
 *  - a line that held an e-mail address or phone number goes as a whole (it is usually "Name, title, number");
 *  - so does the line right before it when that is only a person's name (a contact list puts the name above the number).
 * A name that is not next to an address or number cannot be recognised and stays in the text.
 */

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const PLACEHOLDER = new RegExp(`${escape(EMAIL_PLACEHOLDER)}|${escape(PHONE_PLACEHOLDER)}`);

/** Longest line that is treated as a contact line; a long paragraph that merely mentions an address stays. */
const MAX_CONTACT_LINE_CHARS = 160;
/** "Dr. Erika Musterfrau": two to four capitalised words, optionally with a title, nothing else. */
const NAME_LINE = /^(?:[-•*]\s*)?(?:(?:Dr|Prof)\.?\s+)*\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,3}$/u;
const MAX_NAME_LINE_CHARS = 50;

export function redactJobText(text: string): string {
  const out: string[] = [];
  for (const line of redactContacts(text).split("\n")) {
    if (PLACEHOLDER.test(line) && line.length <= MAX_CONTACT_LINE_CHARS) {
      const previous = out[out.length - 1];
      if (previous !== undefined && previous.length <= MAX_NAME_LINE_CHARS && NAME_LINE.test(previous.trim())) out[out.length - 1] = CONTACT_PLACEHOLDER;
      out.push(CONTACT_PLACEHOLDER);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}
