import type { McpProbe } from "./types";

/**
 * The one-word conclusion: the file cannot be read; off; on; or on with HTTP switched on but refused because no usable web password
 * is set (the doctor warns about exactly this case).
 */
export type McpVerdict = "config_error" | "off" | "on" | "password_required";

export function mcpVerdict(probe: McpProbe): McpVerdict {
  if (probe.state === "config_error") return "config_error";
  if (!probe.enabled) return "off";
  return probe.httpEnabled && !probe.webPasswordUsable ? "password_required" : "on";
}
