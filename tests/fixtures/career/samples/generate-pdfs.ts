import fs from "node:fs";
import path from "node:path";

import { minimalPdf } from "../../pdf";

const root = import.meta.dirname;
fs.writeFileSync(path.join(root, "de-publications.pdf"), minimalPdf(fs.readFileSync(path.join(root, "de-publications.md"), "utf8").split("\n").map((line) => line.replace(/^#+ /, ""))));
const lines = fs.readFileSync(path.join(root, "de-two-column.txt"), "utf8").trim().split("\n");
const escape = (line: string) => line.replace(/[\\()]/g, "\\$&");
const column = (values: string[], x: number) => ["BT", "/F1 10 Tf", "17 TL", `${x} 730 Td`, ...values.flatMap((line) => [`(${escape(line)}) Tj`, "T*"]), "ET"].join("\n");
const stream = [column(lines.slice(0, 6), 36), column(lines.slice(7), 260)].join("\n");
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let body = "%PDF-1.4\n";
const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(body); body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
const xref = Buffer.byteLength(body);
body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(root, "de-two-column.pdf"), body);
