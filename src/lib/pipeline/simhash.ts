import { createHash } from "node:crypto";

/** 64-bit SimHash over word shingles; stored as a 16-character hex string. */

const BITS = 64;

function words(text: string): string[] {
  return text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function hash64(value: string): bigint {
  return createHash("sha256").update(value).digest().readBigUInt64BE(0);
}

export interface SimhashOptions {
  /** Words per shingle. */
  shingleWords: number;
  /** Texts with fewer words get no hash. */
  minWords: number;
}

/** SimHash of `text`, or null when it has fewer than `minWords` words. */
export function simhash(text: string, options: SimhashOptions): string | null {
  const tokens = words(text);
  if (tokens.length < options.minWords || tokens.length === 0) return null;
  const size = Math.min(options.shingleWords, tokens.length);
  const weights = new Array<number>(BITS).fill(0);
  for (let i = 0; i + size <= tokens.length; i += 1) {
    const h = hash64(tokens.slice(i, i + size).join(" "));
    for (let bit = 0; bit < BITS; bit += 1) {
      weights[bit] = (weights[bit] ?? 0) + ((h >> BigInt(bit)) & 1n ? 1 : -1);
    }
  }
  let result = 0n;
  for (let bit = 0; bit < BITS; bit += 1) if ((weights[bit] ?? 0) > 0) result |= 1n << BigInt(bit);
  return result.toString(16).padStart(16, "0");
}

/** Number of differing bits between two hashes from `simhash`. */
export function hammingDistance(a: string, b: string): number {
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}
