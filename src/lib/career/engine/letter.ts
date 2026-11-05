import { CareerEngineError } from "./errors";
import { homeCity, i18n } from "./i18n";
import type { Resume } from "./schema";

export type Letter = NonNullable<Resume["letter"]>;

export interface LetterParts {
  recipient: string[];
  placeDate: string;
  subject?: string;
  salutation: string;
  body: string[];
  closing: string;
  signer: string;
}

export function letterParts(r: Resume, today: string): LetterParts {
  const l = r.letter;
  if (!l) throw new CareerEngineError("career.letter.missing");
  const { w, placeDate } = i18n(r.meta.lang);
  return {
    recipient: l.recipient ?? [],
    placeDate: placeDate(l.place ?? homeCity(r.basics), l.date ?? today),
    subject: l.subject,
    salutation: l.salutation ?? w.salutation,
    body: l.body,
    closing: l.closing ?? w.closing,
    signer: r.basics.name,
  };
}

export const letterSignaturePath = (r: Resume) => r.letter?.signature ?? r.meta.signature?.image;
