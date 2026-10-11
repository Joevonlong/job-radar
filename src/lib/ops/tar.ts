import { createGzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * A minimal ustar writer and reader for the config archive: regular files only (directories are implied by the member
 * names), gzip on top. It does not use the `tar` binary on purpose: bsdtar (macOS) and GNU tar (the container image) take
 * different arguments, so a test and a host run would diverge. The result is read by any tar (`tar -tzf`, `tar -xzf`).
 */

const BLOCK = 512;
const NAME_FIELD = 100;
const PREFIX_FIELD = 155;
const MAX_FILE_BYTES = 8 ** 11 - 1; // the 11 octal digits of the size field

const gunzipAsync = promisify(gunzip);

export interface TarFile {
  /** Member name with `/` separators, relative (`data/config/me.yaml`). */
  name: string;
  data: Buffer;
  /** Permission bits (default 0o600: these are the user's private files). */
  mode?: number;
  /** Seconds since the epoch (default: now). */
  mtime?: number;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

/** Split a long name into the ustar `prefix` (<= 155) and `name` (<= 100) fields at a `/`. Throws when it cannot. */
export function splitTarName(name: string): { prefix: string; name: string } {
  const bytes = Buffer.byteLength(name);
  if (bytes <= NAME_FIELD) return { prefix: "", name };
  for (let at = name.lastIndexOf("/"); at > 0; at = name.lastIndexOf("/", at - 1)) {
    const prefix = name.slice(0, at);
    const rest = name.slice(at + 1);
    if (rest !== "" && Buffer.byteLength(rest) <= NAME_FIELD && Buffer.byteLength(prefix) <= PREFIX_FIELD) return { prefix, name: rest };
  }
  throw new TarError(`path too long for a ustar archive: ${name.slice(0, 60)}...`);
}

function putString(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value, offset, length, "utf8");
}

function putOctal(block: Buffer, offset: number, length: number, value: number): void {
  // `length - 1` octal digits, zero padded, then a NUL.
  block.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
}

function headerFor(file: TarFile): Buffer {
  const { prefix, name } = splitTarName(file.name);
  if (file.data.length > MAX_FILE_BYTES) throw new TarError(`file too large for a ustar archive: ${file.name}`);
  const block = Buffer.alloc(BLOCK);
  putString(block, 0, NAME_FIELD, name);
  putOctal(block, 100, 8, (file.mode ?? 0o600) & 0o7777);
  putOctal(block, 108, 8, 0); // uid
  putOctal(block, 116, 8, 0); // gid
  putOctal(block, 124, 12, file.data.length);
  putOctal(block, 136, 12, Math.max(0, Math.floor(file.mtime ?? Date.now() / 1000)));
  block.fill(0x20, 148, 156); // the checksum is computed with this field as spaces
  block.write("0", 156, 1, "ascii"); // regular file
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  putString(block, 345, PREFIX_FIELD, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

/** The ustar byte stream (uncompressed) for the files, ending with the two zero blocks. */
export function* tarChunks(files: Iterable<TarFile>): Generator<Buffer> {
  for (const file of files) {
    yield headerFor(file);
    yield file.data;
    const remainder = file.data.length % BLOCK;
    if (remainder !== 0) yield Buffer.alloc(BLOCK - remainder);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Write the files as a gzip-compressed tar into `destination` (which is ended). */
export async function writeTarGz(files: Iterable<TarFile>, destination: Writable): Promise<void> {
  await pipeline(Readable.from(tarChunks(files)), createGzip(), destination);
}

export interface TarMember {
  name: string;
  size: number;
  mode: number;
  data: Buffer;
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = block.toString("ascii", offset, offset + length).replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError("corrupt tar header (bad number)");
  return parseInt(text, 8);
}

function readString(block: Buffer, offset: number, length: number): string {
  const end = block.indexOf(0, offset);
  return block.toString("utf8", offset, end === -1 || end > offset + length ? offset + length : end);
}

/** Parse an uncompressed ustar buffer written by `tarChunks` (regular files only). Throws TarError on anything else. */
export function parseTar(buffer: Buffer): TarMember[] {
  const members: TarMember[] = [];
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > buffer.length) throw new TarError("tar archive ends without its end marker");
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return members;
    const stored = readOctal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    if (stored !== sum) throw new TarError("corrupt tar header (checksum)");
    const type = String.fromCharCode(header[156] ?? 0);
    if (type !== "0" && type !== "\0") throw new TarError(`unsupported tar member type '${type}'`);
    const prefix = readString(header, 345, PREFIX_FIELD);
    const rawName = readString(header, 0, NAME_FIELD);
    const size = readOctal(header, 124, 12);
    const start = offset + BLOCK;
    if (start + size > buffer.length) throw new TarError("tar archive is truncated");
    members.push({ name: prefix === "" ? rawName : `${prefix}/${rawName}`, size, mode: readOctal(header, 100, 8), data: buffer.subarray(start, start + size) });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
}

/** Decompress and parse a `.tgz` held in memory. */
export async function readTarGz(compressed: Buffer): Promise<TarMember[]> {
  return parseTar(await gunzipAsync(compressed));
}
