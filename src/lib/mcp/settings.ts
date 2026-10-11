import { ConfigError, loadConfig } from "@/lib/config";
import { MCP_TOOL_NAMES, mcpSchema, type McpConfig, type McpToolName } from "@/lib/config/schemas/mcp";

/**
 * mcp.yaml as the server and doctor read it. A file that is missing from both layers means the schema defaults (off); any other
 * problem (YAML, schema, read error) is thrown, so a broken file never turns the server on or off by accident.
 */
export function readMcpSettings(load: () => McpConfig = () => loadConfig("mcp")): McpConfig {
  try {
    return load();
  } catch (error) {
    if (error instanceof ConfigError && error.kind === "missing") return mcpSchema.parse({});
    throw error;
  }
}

/** The tools mcp.yaml switches on, in their fixed order. */
export function enabledTools(settings: McpConfig): McpToolName[] {
  return MCP_TOOL_NAMES.filter((name) => settings.tools[name]);
}

/**
 * What went wrong with a config file, without the file path or any value (C4): the error kind and the dotted paths of the
 * offending fields.
 */
export function configProblem(error: unknown): string {
  if (!(error instanceof ConfigError)) return "unreadable";
  const paths = [...new Set(error.issues.map((issue) => issue.path).filter((path) => path !== ""))].slice(0, 5);
  return paths.length > 0 ? `${error.kind}: ${paths.join(", ")}` : error.kind;
}
