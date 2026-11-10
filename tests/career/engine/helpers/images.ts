import { deflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
  return bytes;
}

export function imagePng(width = 1, height = 1, pixel: (x: number, y: number) => readonly number[] = () => [0, 0, 0, 255]): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6], 8);
  const pixels = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(pixel(x, y), y * (1 + width * 4) + 1 + x * 4);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** A one-pixel grayscale baseline JPEG with a single zero-coefficient block. */
export function imageJpeg(): Uint8Array {
  const oneCode = [1, ...Array<number>(15).fill(0), 0];
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xdb, 0, 67, 0, ...Array<number>(64).fill(1),
    0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
    0xff, 0xc4, 0, 20, 0, ...oneCode,
    0xff, 0xc4, 0, 20, 0x10, ...oneCode,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x3f,
    0xff, 0xd9,
  ]);
}
