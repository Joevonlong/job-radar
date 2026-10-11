"use server";

import { revalidatePath } from "next/cache";

import {
  applySourcesImport,
  previewSourcesImport,
  removeAtsBoard,
  saveAtsBoard,
  setSourceEnabled,
  type ImportPreviewState,
  type RegistryActionState,
} from "@/lib/sources/registry/service";

// Server Actions are public POST endpoints: every payload is validated again in the service (zod), and the web
// server only listens on 127.0.0.1 / Tailscale (C5).

function refresh(result: RegistryActionState): RegistryActionState {
  if (result.status === "done") {
    revalidatePath("/sources/registry");
    revalidatePath("/sources");
    revalidatePath("/settings");
  }
  return result;
}

export async function setSourceEnabledAction(payload: unknown): Promise<RegistryActionState> {
  return refresh(await setSourceEnabled(payload));
}

export async function saveAtsBoardAction(payload: unknown): Promise<RegistryActionState> {
  return refresh(await saveAtsBoard(payload));
}

export async function removeAtsBoardAction(payload: unknown): Promise<RegistryActionState> {
  return refresh(await removeAtsBoard(payload));
}

export async function previewSourcesImportAction(payload: unknown): Promise<ImportPreviewState> {
  return previewSourcesImport(payload);
}

export async function applySourcesImportAction(payload: unknown): Promise<RegistryActionState> {
  return refresh(await applySourcesImport(payload));
}
