import fsp from "node:fs/promises";
import { z } from "zod";

import { commitConfigFile } from "@/lib/config/atomic";
import { reloadConfig } from "@/lib/config/load";
import { readUserFile } from "@/lib/config/read-user-file";
import { withFileLock } from "@/lib/config/write";
import { lockLostError, withConfigWriteLock } from "@/lib/config/write-lock";
import { CareerStoreError } from "../contact/errors";
import { careerImagePath } from "./paths";

export type ImageKind = "photo" | "signature";
export interface CareerImages { photo?: Uint8Array; signature?: Uint8Array }
const extensions = ["png", "jpg"] as const;

function extension(bytes: Uint8Array): "png" | "jpg" {
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  throw new CareerStoreError("image_invalid");
}

export async function saveImage(kind: ImageKind, bytes: Uint8Array): Promise<void> {
  const fileLock = careerImagePath(kind, "png");
  if (!z.instanceof(Uint8Array).safeParse(bytes).success) throw new CareerStoreError("image_invalid");
  if (bytes.byteLength > reloadConfig("career").document.image_max_bytes) throw new CareerStoreError("image_too_large");
  const content = Buffer.from(bytes);
  const ext = extension(content);
  await withFileLock(fileLock, () => withConfigWriteLock(async (lock) => {
    await commitConfigFile(careerImagePath(kind, ext), content);
    const other = careerImagePath(kind, ext === "png" ? "jpg" : "png");
    if (!(await lock.fence())) throw lockLostError(other);
    await fsp.rm(other, { force: true });
  }, fileLock));
}

export async function loadImages(): Promise<CareerImages> {
  const images: CareerImages = {};
  for (const kind of ["photo", "signature"] as const) {
    for (const ext of extensions) {
      try {
        const bytes = readUserFile(careerImagePath(kind, ext));
        if (bytes.byteLength > reloadConfig("career").document.image_max_bytes) throw new CareerStoreError("image_too_large");
        if (extension(bytes) !== ext) throw new CareerStoreError("image_invalid");
        images[kind] = bytes;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (error instanceof CareerStoreError) throw error;
          throw new CareerStoreError("image_invalid");
        }
      }
    }
  }
  return images;
}

export async function deleteImage(kind: ImageKind): Promise<void> {
  const file = careerImagePath(kind, "png");
  await withFileLock(file, () => withConfigWriteLock(async (lock) => {
    for (const ext of extensions) {
      const target = careerImagePath(kind, ext);
      if (!(await lock.fence())) throw lockLostError(target);
      await fsp.rm(target, { force: true });
    }
  }, file));
}


/** Presence checks expose no image bytes or storage names. */
export async function imagePresence(): Promise<{ hasPhoto: boolean; hasSignature: boolean }> {
  const exists = async (kind: ImageKind) => {
    for (const ext of extensions) {
      try {
        if ((await fsp.stat(careerImagePath(kind, ext))).isFile()) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CareerStoreError("image_invalid");
      }
    }
    return false;
  };
  return { hasPhoto: await exists("photo"), hasSignature: await exists("signature") };
}
