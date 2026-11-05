const WIN_ANSI = new Map([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"].map((char, i) => [char, [128, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 142, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 158, 159][i]]));

function hexText(line: string): string {
  return [...line].map((char) => {
    const point = char.codePointAt(0)!;
    const byte = WIN_ANSI.get(char) ?? (point >= 32 && point <= 255 ? point : undefined);
    if (byte === undefined) throw new Error(`Text PDF needs a WinAnsi character: ${char}`);
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

export function textPdf(pages: string[][]): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  pages.forEach((lines, i) => {
    const height = Math.max(842, lines.length * 14 + 40);
    const stream = ["BT /F1 10 Tf 14 TL", `20 ${height - 20} Td`, ...lines.map((line) => `<${hexText(line)}> Tj T*`), "ET\n"].join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20000 ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
