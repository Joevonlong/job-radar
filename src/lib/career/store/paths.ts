import path from "node:path";

import { getProfileDir } from "@/lib/config/paths";

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
