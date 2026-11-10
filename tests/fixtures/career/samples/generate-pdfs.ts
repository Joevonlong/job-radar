import fs from "node:fs";
import path from "node:path";

const root = import.meta.dirname;

function wrap(lines: string[], width: number): string[] {
  return lines.flatMap((line) => {
    const words = line.split(" ");
    const result = [""];
    for (const word of words) {
      const last = result.length - 1;
      if (result[last] && result[last]!.length + word.length + 1 > width) result.push(word);
      else result[last] += (result[last] ? " " : "") + word;
    }
    return result;
  });
}

function pdf(pages: { lines: string[]; x: number; size: number }[][]): Buffer {
  const font = 3 + pages.length * 2;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  for (const [i, columns] of pages.entries()) {
    const stream = columns.map(({ lines, x, size }) => ["BT", `/F1 ${size} Tf`, "12 TL", `${x} 750 Td`, ...lines.flatMap((line) => {
      const bytes = Buffer.from(line.replaceAll("–", "\x96"), "latin1").toString("hex");
      return [`<${bytes}> Tj`, "T*"];
    }), "ET"].join("\n")).join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(body); body += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

const publication = wrap(fs.readFileSync(path.join(root, "de-publications.md"), "utf8").trim().split("\n"), 95);
const publicationPages = Array.from({ length: Math.ceil(publication.length / 58) }, (_, i) => [{ lines: publication.slice(i * 58, (i + 1) * 58), x: 42, size: 10 }]);
fs.writeFileSync(path.join(root, "de-publications.pdf"), pdf(publicationPages));
const lines = fs.readFileSync(path.join(root, "de-two-column.txt"), "utf8").trim().split("\n");
const experience = lines.indexOf("Berufliche Stationen");
const education = lines.indexOf("Ausbildung");
const left = wrap([...lines.slice(0, experience), ...lines.slice(education)], 42);
const right = wrap(lines.slice(experience, education), 50);
const columnPages = Array.from({ length: Math.ceil(Math.max(left.length, right.length) / 58) }, (_, i) => [
  { lines: left.slice(i * 58, (i + 1) * 58), x: 36, size: 8 },
  { lines: right.slice(i * 58, (i + 1) * 58), x: 280, size: 8 },
]);
fs.writeFileSync(path.join(root, "de-two-column.pdf"), pdf(columnPages));
