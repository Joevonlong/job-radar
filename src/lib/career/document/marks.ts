import type { Claim, DocText } from "../schema/document";

export type DocumentMark = "unverified" | "confirmed" | "user_written" | "rewritten" | "verbatim";
const RULES: readonly [DocumentMark, (text: Pick<DocText, "origin">, claims: readonly Claim[]) => boolean][] = [
  ["unverified", (_, claims) => claims.some((claim) => claim.by === "ai" && ["pending", "rejected"].includes(claim.status))],
  ["confirmed", (_, claims) => claims.some((claim) => claim.status === "confirmed")],
  ["user_written", (text, claims) => text.origin === "user" || claims.some((claim) => claim.by === "user")],
  ["rewritten", (text) => text.origin === "ai"],
  ["verbatim", () => true],
];

export function markOf(text: Pick<DocText, "id" | "origin">, claims: readonly Claim[]): DocumentMark {
  const relevant = claims.filter((claim) => "text" in claim.target && claim.target.text === text.id);
  return RULES.find(([, matches]) => matches(text, relevant))![0];
}
