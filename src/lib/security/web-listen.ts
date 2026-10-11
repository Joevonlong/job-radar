/**
 * Where `pnpm start` / `pnpm dev` make Next listen, and what the web is told about it (`scripts/web-run.ts`). The local
 * login exemption trusts `JOB_RADAR_WEB_BIND` (see `local-request.ts`), so the launcher makes the variable and the real
 * listen address agree:
 *
 * - an explicit `-H` / `--hostname` argument wins and becomes the bind the web is told (brackets of an IPv6 address
 *   such as `[::1]` are removed before Next gets it);
 * - otherwise `JOB_RADAR_WEB_BIND` (from the environment or `.env`) is passed to Next as `-H`;
 * - otherwise Next listens on every interface, and the web is told `0.0.0.0` (so nobody skips the login).
 *
 * Pure (unit-tested).
 */

export interface WebListenPlan {
  /** The arguments for `next start` / `next dev`. */
  args: string[];
  /** The value of `JOB_RADAR_WEB_BIND` for the Next process: the address it listens on. */
  bind: string;
}

/** Every interface: what Next listens on without `-H`. */
export const ALL_INTERFACES = "0.0.0.0";

/**
 * Split off the hostname arguments (`-H x`, `-Hx`, `--hostname x`, `--hostname=x`): the other arguments, and the value of
 * the last hostname argument (null when there is none).
 */
function splitHostname(args: readonly string[]): { rest: string[]; host: string | null } {
  const rest: string[] = [];
  let host: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-H" || arg === "--hostname") {
      host = args[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--hostname=")) {
      host = arg.slice("--hostname=".length);
    } else if (arg.startsWith("-H") && arg.length > 2) {
      host = arg.slice(2);
    } else {
      rest.push(arg);
    }
  }
  return { rest, host };
}

/** `[::1]` -> `::1`: Node listens on the bare address (the brackets belong in URLs only). */
function unbracket(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export function planWebListen(args: readonly string[], bindEnv: string | undefined): WebListenPlan {
  const { rest, host: explicit } = splitHostname(args);
  const bind = unbracket((explicit ?? bindEnv ?? "").trim());
  if (bind === "") return { args: rest, bind: ALL_INTERFACES };
  // the hostname goes to Next exactly once, without brackets
  return { args: [...rest, "-H", bind], bind };
}
