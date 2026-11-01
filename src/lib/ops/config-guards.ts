/**
 * What the worker-side config guards do with the current configuration: codex overrides dropped, CLI commands refused,
 * credentials kept from custom endpoints (or sent there with the opt-in). Read by the ai-worker's start-up log and the
 * doctor (`config.guards`); the guards themselves act where the request is made (providers, Telegram, channels).
 */
import { cliCommandProblem, cliModelProblem, filterCodexOverrides } from "@/lib/ai/providers/cli-guards";
import type { AiConfig, ChannelsConfig, NotifyConfig } from "@/lib/config";
import { ALLOW_CUSTOM_ENDPOINTS_ENV, checkCredentialEndpoint, checkImapEndpoint, customEndpointsAllowed, type CredentialService } from "@/lib/credential-endpoints";

export type GuardFindingKind = "override_dropped" | "command_refused" | "model_refused" | "endpoint_refused" | "endpoint_custom" | "custom_endpoints_env";

export interface GuardFinding {
  kind: GuardFindingKind;
  /** English, for logs; the doctor builds its own text from `kind` and `subject`. */
  message: string;
  /** The config key or setting the finding is about (`ai.yaml providers.codex_cli.config_overrides.mcp_servers.x`). */
  subject: string;
}

export interface GuardConfigs {
  ai: AiConfig;
  notify?: NotifyConfig;
  channels?: ChannelsConfig;
}

function endpointFinding(service: Exclude<CredentialService, "gmail">, url: string, env: Readonly<Record<string, string | undefined>>, subject: string): GuardFinding | null {
  const verdict = checkCredentialEndpoint(service, url, env);
  if (verdict.status === "default") return null;
  return { kind: verdict.status === "refused" ? "endpoint_refused" : "endpoint_custom", message: verdict.message, subject };
}

export function configGuardFindings(configs: GuardConfigs, env: Readonly<Record<string, string | undefined>> = process.env): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const { ai } = configs;
  if (customEndpointsAllowed(env)) {
    findings.push({ kind: "custom_endpoints_env", subject: ALLOW_CUSTOM_ENDPOINTS_ENV, message: `${ALLOW_CUSTOM_ENDPOINTS_ENV}=1: API keys and the Telegram token may be sent to hosts other than the vendors' own` });
  }
  for (const key of filterCodexOverrides(ai.providers.codex_cli.config_overrides).dropped) {
    findings.push({
      kind: "override_dropped",
      subject: `ai.yaml providers.codex_cli.config_overrides.${key}`,
      message: `ai.yaml providers.codex_cli.config_overrides: "${key}" is not an allowed key and is ignored`,
    });
  }
  for (const [provider, command] of [["claude-cli", ai.providers.claude_cli.command], ["codex-cli", ai.providers.codex_cli.command]] as const) {
    const problem = cliCommandProblem(provider, command);
    if (problem !== null) findings.push({ kind: "command_refused", subject: `ai.yaml providers.${provider.replace("-", "_")}.command`, message: problem });
  }
  const models: [string, "claude-cli" | "codex-cli", string | undefined][] = [
    ["ai.yaml providers.claude_cli.model", "claude-cli", ai.providers.claude_cli.model],
    ["ai.yaml providers.claude_cli.strong_model", "claude-cli", ai.providers.claude_cli.strong_model],
    ["ai.yaml providers.codex_cli.model", "codex-cli", ai.providers.codex_cli.model],
  ];
  for (const [subject, provider, model] of models) {
    const problem = model === undefined ? null : cliModelProblem(provider, model);
    if (problem !== null) findings.push({ kind: "model_refused", subject, message: problem });
  }
  const endpoints: { service: Exclude<CredentialService, "gmail">; url: string; subject: string; used: boolean }[] = [
    { service: "openai", url: ai.providers.openai.base_url, subject: "ai.yaml providers.openai.base_url", used: ai.providers.openai.enabled },
    { service: "openrouter", url: ai.providers.openrouter.base_url, subject: "ai.yaml providers.openrouter.base_url", used: ai.providers.openrouter.enabled },
    { service: "deepseek", url: ai.providers.deepseek.base_url, subject: "ai.yaml providers.deepseek.base_url", used: ai.providers.deepseek.enabled },
    { service: "mimo", url: ai.providers.mimo.base_url, subject: "ai.yaml providers.mimo.base_url", used: ai.providers.mimo.enabled },
  ];
  if (configs.notify) endpoints.push({ service: "telegram", url: configs.notify.telegram.api_base_url, subject: "notify.yaml telegram.api_base_url", used: configs.notify.telegram.enabled });
  if (configs.channels) {
    const { sources, linkedin } = configs.channels;
    endpoints.push(
      { service: "jsearch", url: sources.jsearch.api_base_url, subject: "sources.yaml sources.jsearch.api_base_url", used: sources.jsearch.enabled },
      { service: "tavily", url: sources.tavily.api_base_url, subject: "sources.yaml sources.tavily.api_base_url", used: sources.tavily.enabled },
      { service: "brave", url: sources.brave.api_base_url, subject: "sources.yaml sources.brave.api_base_url", used: sources.brave.enabled },
      { service: "apify", url: linkedin.apify.api_base_url, subject: "sources.yaml linkedin.apify.api_base_url", used: linkedin.apify.enabled },
      { service: "monid", url: linkedin.monid.api_base_url, subject: "sources.yaml linkedin.monid.api_base_url", used: linkedin.monid.enabled },
    );
  }
  // A changed URL is reported even while its provider / channel is off: switching it on would send the key there.
  for (const endpoint of endpoints) {
    const finding = endpointFinding(endpoint.service, endpoint.url, env, endpoint.subject);
    if (finding) findings.push(finding);
  }
  if (configs.channels) {
    const { host, port, secure } = configs.channels.sources.gmail;
    const verdict = checkImapEndpoint(host, port, secure, env);
    if (verdict.status !== "default") {
      findings.push({ kind: verdict.status === "refused" ? "endpoint_refused" : "endpoint_custom", message: verdict.message, subject: "sources.yaml sources.gmail host / port / secure" });
    }
  }
  return findings;
}
