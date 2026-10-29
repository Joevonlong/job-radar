import { z } from "zod";

export const BOARD_DENSITY_COOKIE = "jr_board_density";
export const boardDensitySchema = z.enum(["compact", "comfortable"]);
export type BoardDensity = z.infer<typeof boardDensitySchema>;

export function resolveBoardDensity(value: unknown, fallback: BoardDensity): BoardDensity {
  const parsed = boardDensitySchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function boardDensityCookie(value: BoardDensity, rememberDays: number): string {
  return `${BOARD_DENSITY_COOKIE}=${value}; Path=/; Max-Age=${rememberDays * 24 * 60 * 60}; SameSite=Lax`;
}
