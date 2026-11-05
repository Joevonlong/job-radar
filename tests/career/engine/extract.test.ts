// @vitest-environment node
import { expect, test } from "vitest";
import { countPages, extractPages, extractText } from "../../../src/lib/career/engine";
import { textPdf } from "./helpers/pdf";

test("page count follows the PDF page tree and text extraction preserves page boundaries", async () => {
  const pdf = textPdf([["Test Person", "A literal /Type /Page is text", "Müller – € (one) \\ two"], [], ["Last page"]]);
  const original = pdf.slice();
  expect(await countPages(pdf)).toBe(3);
  expect(await extractPages(pdf)).toEqual(["Test Person\nA literal /Type /Page is text\nMüller – € (one) \\ two\n", "\n", "Last page\n"]);
  expect(await extractText(pdf)).toBe("Test Person\nA literal /Type /Page is text\nMüller – € (one) \\ two\n\nLast page\n");
  expect(await countPages(pdf)).toBe(3);
  expect(pdf).toEqual(original);
});

test("a malformed PDF fails parsing", async () => {
  await expect(countPages(new TextEncoder().encode("not a PDF"))).rejects.toThrow();
  await expect(extractText(new TextEncoder().encode("not a PDF"))).rejects.toThrow();
});
