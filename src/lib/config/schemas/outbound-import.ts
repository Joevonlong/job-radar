import { z } from "zod";

const words = z.array(z.string().trim().min(1).max(200)).max(100);

export const outboundImportFields = {
  title_words: words.default(["Lebenslauf", "Curriculum Vitae", "CV", "Resume", "Résumé", "Tabellarischer Lebenslauf"]),
  sensitive_labels: words.default([
    "Geburtsdatum", "Geburtsort", "Staatsangehörigkeit", "Nationalität", "Familienstand", "Anschrift",
    "Date of birth", "Place of birth", "Nationality", "Marital status", "Address",
  ]),
};
