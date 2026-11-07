import path from "node:path";
import { z } from "zod";

import { getProfileDir } from "@/lib/config/paths";
import { CareerStoreError } from "../contact/errors";
import { documentIdSchema } from "../schema/document";

export function careerDir(): string {
  return path.join(getProfileDir(), "career");
}
export function careerProfilePath(): string {
  return path.join(careerDir(), "profile.yaml");
}
export function careerContactPath(): string {
  return path.join(careerDir(), "contact.yaml");
}
export function careerHistoryDir(): string {
  return path.join(careerDir(), "history");
}
export function careerDocumentsDir(): string {
  return path.join(careerDir(), "documents");
}
export function careerDocumentPath(id: string): string {
  if (!documentIdSchema.safeParse(id).success) throw new CareerStoreError("document_missing");
  return path.join(careerDocumentsDir(), `${id}.yaml`);
}
export function careerDocumentHistoryDir(id: string): string {
  careerDocumentPath(id);
  return path.join(careerHistoryDir(), "documents", id);
}
export function careerApplyStatePath(): string {
  return path.join(careerDir(), "apply-state.yaml");
}
export function careerPreferencesPath(): string {
  return path.join(careerDir(), "preferences.yaml");
}
export function careerImagePath(kind: "photo" | "signature", extension: "png" | "jpg"): string {
  if (!z.enum(["photo", "signature"]).safeParse(kind).success || !z.enum(["png", "jpg"]).safeParse(extension).success) throw new CareerStoreError("image_invalid");
  return path.join(careerDir(), `${kind}.${extension}`);
}
