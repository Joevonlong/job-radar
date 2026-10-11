/**
 * `fetch` for URLs that came from data (link checks, the recheck of watched postings), with the public-address check done
 * where the connection is made. `publicUrlProblem` checks a URL before it is requested, but `fetch` would then resolve
 * the name a second time: a record with a very short TTL could answer a public address to the check and a private one
 * (the Docker network, this machine) to the connection (DNS rebinding). Here the socket's own lookup resolves the name,
 * refuses when any address is not public, and hands exactly the checked addresses to the connection.
 *
 * IP literals do not go through a lookup; `publicUrlProblem` refuses non-public ones before anything is sent.
 * Server / Node only (the runner).
 */
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import type { FetchLike } from "@/lib/channels/http";
import type { HttpResponse } from "@/lib/channels/types";

import { isNonPublicAddress, systemResolver, type HostResolver } from "./public-url";

/** A connection was refused because the name resolved to an address that is not public. */
export class NonPublicAddressError extends Error {
  readonly code = "ENONPUBLIC";
  constructor(host: string) {
    super(`${host} resolves to an address that is not public: not connecting`);
    this.name = "NonPublicAddressError";
  }
}

export interface PublicOnlyOptions {
  /** Resolves a host name (default: the system resolver, every address). */
  resolve?: HostResolver;
  /** Which addresses are refused (default: `isNonPublicAddress`). Tests let loopback through to observe the connection. */
  refuse?: (address: string) => boolean;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` for `net.connect` / `tls.connect`: the resolved addresses when all are public, an error otherwise. */
export function publicOnlyLookup(resolve: HostResolver = systemResolver, refuse: (address: string) => boolean = isNonPublicAddress): LookupFunction {
  return (hostname, options, callback: LookupCallback) => {
    resolve(hostname).then(
      (resolved) => {
        if (resolved.length === 0) {
          callback(Object.assign(new Error(`${hostname} did not resolve`), { code: "ENOTFOUND" }), "", 0);
          return;
        }
        if (resolved.some(refuse)) {
          callback(new NonPublicAddressError(hostname), "", 0);
          return;
        }
        const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
        const entries = resolved.map((address) => ({ address, family: isIP(address) })).filter((entry) => entry.family !== 0 && (wanted === 0 || entry.family === wanted));
        const first = entries[0];
        if (first === undefined) {
          callback(Object.assign(new Error(`${hostname} has no address of family ${wanted}`), { code: "ENOTFOUND" }), "", 0);
          return;
        }
        if (options.all === true) callback(null, entries);
        else callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), "", 0),
    );
  };
}

/** A `FetchLike` whose connections only go to public addresses, with its own connection pool; `close()` releases it. */
export type PublicOnlyFetch = FetchLike & { close(): Promise<void> };

/** A `FetchLike` whose connections only go to public addresses (its own connection pool: close it when done). */
export function createPublicOnlyFetch(options: PublicOnlyOptions = {}): PublicOnlyFetch {
  const agent = new Agent({ connect: { lookup: publicOnlyLookup(options.resolve, options.refuse) } });
  const fetch = async (url: string, init: Parameters<FetchLike>[1]): Promise<HttpResponse> => {
    const response = await undiciFetch(url, { ...init, dispatcher: agent });
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: () => response.text(),
      json: () => response.json(),
      body: response.body as ReadableStream<Uint8Array> | null,
    };
  };
  return Object.assign(fetch, { close: () => agent.close() });
}

let shared: PublicOnlyFetch | null = null;

/** The process-wide public-only fetch with the system resolver (one pool for every maintenance run; never closed). */
export function sharedPublicOnlyFetch(): FetchLike {
  shared ??= createPublicOnlyFetch();
  return shared;
}
