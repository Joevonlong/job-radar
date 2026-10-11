/** Client-safe pieces of the resume-kit hand-off (no node imports): shared by the server actions and the components. */

export const PDF_ERRORS = ["not_configured", "invalid", "outside", "not_found", "not_pdf"] as const;
export type PdfPathError = (typeof PDF_ERRORS)[number];

/** The file name shown on a card ("Acme_AI-Engineer.pdf") for a stored PDF path (POSIX or Windows separators). */
export function pdfDisplayName(storedPath: string): string {
  const parts = storedPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? storedPath;
}
