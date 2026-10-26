// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ALLOW_CUSTOM_ENDPOINTS_ENV, checkCredentialEndpoint, checkImapEndpoint, CREDENTIAL_ENDPOINTS, customEndpointsAllowed, isDefaultEndpoint } from "@/lib/credential-endpoints";

const OPT_IN = { [ALLOW_CUSTOM_ENDPOINTS_ENV]: "1" };

describe("credential endpoints", () => {
  it("the vendor's own host over https is the default, whatever the path", () => {
    expect(checkCredentialEndpoint("deepseek", "https://api.deepseek.com", {})).toEqual({ status: "default" });
    expect(checkCredentialEndpoint("mimo", "https://api.xiaomimimo.com/v1", {})).toEqual({ status: "default" });
    expect(checkCredentialEndpoint("telegram", "https://API.telegram.org/", {})).toEqual({ status: "default" });
    expect(checkCredentialEndpoint("jsearch", "https://jsearch.p.rapidapi.com", {})).toEqual({ status: "default" });
    expect(checkCredentialEndpoint("monid", "https://api.monid.ai", {})).toEqual({ status: "default" });
  });

  it.each([
    ["another host", "https://evil.example"],
    ["a look-alike subdomain", "https://api.deepseek.com.evil.example"],
    ["plain http", "http://api.deepseek.com"],
    ["another port", "https://api.deepseek.com:8443"],
    ["user info", "https://user:pw@api.deepseek.com"],
    ["no URL at all", "not a url"],
    ["loopback", "http://127.0.0.1:9999"],
  ])("refuses %s without the opt-in, and names neither key nor path", (_label, url) => {
    const verdict = checkCredentialEndpoint("deepseek", url, {});
    expect(verdict.status).toBe("refused");
    expect(verdict.status === "refused" && verdict.message).toContain(ALLOW_CUSTOM_ENDPOINTS_ENV);
    expect(isDefaultEndpoint("deepseek", url)).toBe(false);
  });

  it("another host is allowed only with JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1, and then reported as custom", () => {
    expect(checkCredentialEndpoint("telegram", "https://proxy.example/tg", OPT_IN)).toMatchObject({ status: "custom", message: expect.stringContaining("https://proxy.example") });
    expect(checkCredentialEndpoint("telegram", "https://proxy.example/tg", { [ALLOW_CUSTOM_ENDPOINTS_ENV]: "true" }).status).toBe("refused");
    expect(customEndpointsAllowed({ [ALLOW_CUSTOM_ENDPOINTS_ENV]: " 1 " })).toBe(true);
    expect(customEndpointsAllowed({})).toBe(false);
  });

  it("covers every service that sends a credential", () => {
    expect(Object.keys(CREDENTIAL_ENDPOINTS).sort()).toEqual(["apify", "brave", "deepseek", "gmail", "jsearch", "mimo", "monid", "tavily", "telegram"]);
  });
});

describe("Gmail IMAP endpoint", () => {
  it("only imap.gmail.com on 993 with TLS is the default", () => {
    expect(checkImapEndpoint("imap.gmail.com", 993, true, {})).toEqual({ status: "default" });
    expect(checkImapEndpoint("IMAP.gmail.com", 993, true, {})).toEqual({ status: "default" });
  });

  it.each([
    ["another host", "imap.evil.example", 993, true],
    ["no TLS", "imap.gmail.com", 993, false],
    ["another port", "imap.gmail.com", 143, true],
  ])("refuses %s without the opt-in, allows it with JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1", (_label, host, port, secure) => {
    const refused = checkImapEndpoint(host, port, secure, {});
    expect(refused.status).toBe("refused");
    expect(refused.status === "refused" && refused.message).toContain("imaps://imap.gmail.com:993");
    expect(checkImapEndpoint(host, port, secure, OPT_IN).status).toBe("custom");
  });
});
