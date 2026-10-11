import { checkCredentialEndpoint, type CredentialService } from "@/lib/credential-endpoints";

import { ChannelError } from "./errors";
import type { ChannelContext } from "./types";

/**
 * Before a channel sends its API key: the configured base URL must be the vendor's own host, unless the user opted in
 * with `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` (then the run goes on with a warning). A refused URL fails the run without
 * sending anything and without a retry.
 */
export function assertCredentialEndpoint(service: Exclude<CredentialService, "gmail">, url: string, ctx: Pick<ChannelContext, "logger">, env: Readonly<Record<string, string | undefined>>): void {
  const verdict = checkCredentialEndpoint(service, url, env);
  if (verdict.status === "refused") throw new ChannelError("unknown", verdict.message, { retryable: false });
  if (verdict.status === "custom") ctx.logger.warn(`${service}: custom API endpoint`, { reason: verdict.message });
}
