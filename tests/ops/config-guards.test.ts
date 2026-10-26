// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";
import { configGuardFindings } from "@/lib/ops/config-guards";

import { pinnedAi } from "../ai/helpers";
import { shippedYaml } from "../config/helpers";

const notify = (edit: (raw: { telegram: Record<string, unknown> }) => void = () => {}) => {
  const raw = structuredClone(shippedYaml("notify.yaml")) as { telegram: Record<string, unknown> };
  edit(raw);
  return configRegistry.notify.schema.parse(raw);
};
const channels = (edit: (raw: Record<string, Record<string, Record<string, unknown>>>) => void = () => {}) => {
  const raw = structuredClone(shippedYaml("sources.yaml")) as Record<string, Record<string, Record<string, unknown>>>;
  edit(raw);
  return configRegistry.channels.schema.parse(raw);
};

describe("config guard findings", () => {
  it("reports a custom Monid endpoint even while the channel is disabled", () => {
    const value = channels((raw) => {
      raw.linkedin!.monid!.enabled = false;
      raw.linkedin!.monid!.api_base_url = "https://monid-proxy.example";
    });
    expect(configGuardFindings({ ai: pinnedAi(), channels: value }, {})).toMatchObject([
      { kind: "endpoint_refused", subject: "sources.yaml linkedin.monid.api_base_url" },
    ]);
    expect(configGuardFindings({ ai: pinnedAi(), channels: value }, { JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" }).map((finding) => finding.kind)).toEqual(["custom_endpoints_env", "endpoint_custom"]);
  });

  it("a default setup has none", () => {
    expect(configGuardFindings({ ai: pinnedAi(), notify: notify(), channels: channels() }, {})).toEqual([]);
  });

  it("reports dropped overrides, refused commands, refused or custom endpoints and the opt-in variable", () => {
    const ai = pinnedAi((raw) => {
      const providers = raw.providers as Record<string, Record<string, unknown>>;
      (providers.codex_cli!.config_overrides as Record<string, string>)["mcp_servers.x.command"] = '"sh"';
      providers.claude_cli!.command = "/bin/sh";
      providers.deepseek!.base_url = "https://evil.example";
      providers.codex_cli!.model = "-x";
    });
    const findings = configGuardFindings(
      {
        ai,
        notify: notify((raw) => { raw.telegram.api_base_url = "https://tg-proxy.example"; }),
        channels: channels((raw) => {
          raw.sources!.tavily!.api_base_url = "https://tavily-proxy.example";
          raw.sources!.gmail!.host = "imap.evil.example";
        }),
      },
      {},
    );
    expect(findings.map((f) => [f.kind, f.subject])).toEqual([
      ["override_dropped", "ai.yaml providers.codex_cli.config_overrides.mcp_servers.x.command"],
      ["command_refused", "ai.yaml providers.claude_cli.command"],
      ["model_refused", "ai.yaml providers.codex_cli.model"],
      ["endpoint_refused", "ai.yaml providers.deepseek.base_url"],
      ["endpoint_refused", "notify.yaml telegram.api_base_url"],
      ["endpoint_refused", "sources.yaml sources.tavily.api_base_url"],
      ["endpoint_refused", "sources.yaml sources.gmail host / port / secure"],
    ]);

    const optedIn = configGuardFindings({ ai, notify: notify((raw) => { raw.telegram.api_base_url = "https://tg-proxy.example"; }) }, { JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" });
    expect(optedIn.map((f) => f.kind)).toEqual(["custom_endpoints_env", "override_dropped", "command_refused", "model_refused", "endpoint_custom", "endpoint_custom"]);
  });
});
