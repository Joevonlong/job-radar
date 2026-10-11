/**
 * The MCP server's texts (tool descriptions, notices, errors, the start-up lines on stderr), from `messages/` in the command-line
 * language (`language.yaml: cli.locale`).
 */
import type { Locale } from "@/i18n/locale";
import { scopeLocale, translatorFor } from "@/lib/i18n/node";

export function mcpTranslator(locale: Locale = scopeLocale("cli")) {
  return translatorFor(locale, "mcp");
}

export type McpTranslator = ReturnType<typeof mcpTranslator>;
