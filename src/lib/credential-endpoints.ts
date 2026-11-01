/**
 * Where a request that carries a credential (an API key, the Telegram bot token) may go.
 *
 * The config files are editable from the web UI, but the keys live in the environment of the processes that read them
 * (ai-worker, runner). So a changed `base_url` / `api_base_url` must never be enough to send a key somewhere else: by
 * default such a request only goes to the vendor's own host (the one the shipped config names). Users who really need
 * another host (a proxy, a self-hosted gateway) set `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` in `.env`; every request to a
 * custom host is then allowed and logged as a warning, and the doctor shows it.
 *
 * The host lists are code on purpose: they are the boundary that protects the keys, so they cannot live in the files
 * they protect against.
 */

export const ALLOW_CUSTOM_ENDPOINTS_ENV = "JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS";

/** Each service that sends a credential: the config key holding its URL and the hosts it may reach without the opt-in. */
export const CREDENTIAL_ENDPOINTS = {
  openai: { setting: "ai.yaml providers.openai.base_url", hosts: ["api.openai.com"] },
  openrouter: { setting: "ai.yaml providers.openrouter.base_url", hosts: ["openrouter.ai"] },
  deepseek: { setting: "ai.yaml providers.deepseek.base_url", hosts: ["api.deepseek.com"] },
  mimo: { setting: "ai.yaml providers.mimo.base_url", hosts: ["api.xiaomimimo.com"] },
  telegram: { setting: "notify.yaml telegram.api_base_url", hosts: ["api.telegram.org"] },
  jsearch: { setting: "sources.yaml sources.jsearch.api_base_url", hosts: ["jsearch.p.rapidapi.com"] },
  tavily: { setting: "sources.yaml sources.tavily.api_base_url", hosts: ["api.tavily.com"] },
  brave: { setting: "sources.yaml sources.brave.api_base_url", hosts: ["api.search.brave.com"] },
  apify: { setting: "sources.yaml linkedin.apify.api_base_url", hosts: ["api.apify.com"] },
  monid: { setting: "sources.yaml linkedin.monid.api_base_url", hosts: ["api.monid.ai"] },
  /** IMAP, not https: checked by `checkImapEndpoint` (implicit TLS on port 993). */
  gmail: { setting: "sources.yaml sources.gmail host / port / secure", hosts: ["imap.gmail.com"] },
} as const satisfies Record<string, { setting: string; hosts: readonly string[] }>;

export type CredentialService = keyof typeof CREDENTIAL_ENDPOINTS;

export type EndpointVerdict =
  /** The vendor's own host over https. */
  | { status: "default" }
  /** Another host, allowed by `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1`: the caller logs `message` as a warning. */
  | { status: "custom"; message: string }
  /** Another host without the opt-in: the request must not be sent. */
  | { status: "refused"; message: string };

export function customEndpointsAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[ALLOW_CUSTOM_ENDPOINTS_ENV]?.trim() === "1";
}

function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "an invalid URL";
  }
}

/** Is `url` the default endpoint of `service` (https, its own host, default port, no user info)? */
export function isDefaultEndpoint(service: Exclude<CredentialService, "gmail">, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hosts: readonly string[] = CREDENTIAL_ENDPOINTS[service].hosts;
  return parsed.protocol === "https:" && parsed.port === "" && parsed.username === "" && parsed.password === "" && hosts.includes(parsed.hostname.toLowerCase());
}

/** May a request of `service` carrying its credential be sent to `url`? */
export function checkCredentialEndpoint(service: Exclude<CredentialService, "gmail">, url: string, env: Readonly<Record<string, string | undefined>> = process.env): EndpointVerdict {
  if (isDefaultEndpoint(service, url)) return { status: "default" };
  return nonDefault(service, describeTarget(url), env);
}

/** The Gmail login goes only to imap.gmail.com over implicit TLS on port 993, unless the user opted in. */
export function checkImapEndpoint(host: string, port: number, secure: boolean, env: Readonly<Record<string, string | undefined>> = process.env): EndpointVerdict {
  const hosts: readonly string[] = CREDENTIAL_ENDPOINTS.gmail.hosts;
  if (secure && port === 993 && hosts.includes(host.trim().toLowerCase())) return { status: "default" };
  return nonDefault("gmail", `${secure ? "imaps" : "imap (no TLS)"}://${host}:${port}`, env, "imaps://imap.gmail.com:993");
}

function nonDefault(service: CredentialService, target: string, env: Readonly<Record<string, string | undefined>>, expected?: string): EndpointVerdict {
  const { setting, hosts } = CREDENTIAL_ENDPOINTS[service];
  const vendor = expected ?? hosts.join(" / ");
  if (customEndpointsAllowed(env)) {
    return { status: "custom", message: `${setting} points to ${target}, not ${vendor}: the ${service} credential is sent there (${ALLOW_CUSTOM_ENDPOINTS_ENV}=1)` };
  }
  return {
    status: "refused",
    message: `${setting} points to ${target}, not ${vendor}: the ${service} credential is not sent to another host unless ${ALLOW_CUSTOM_ENDPOINTS_ENV}=1 is set in .env`,
  };
}
