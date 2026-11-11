import { reloadConfig } from "./load";

/** A broken or missing config always closes the gate, even after a cached enabled value. */
export async function readCareerGate(): Promise<{ enabled: boolean }> {
  try {
    return { enabled: reloadConfig("career").enabled };
  } catch {
    return { enabled: false };
  }
}
