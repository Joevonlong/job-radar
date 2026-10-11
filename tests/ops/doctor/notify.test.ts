// @vitest-environment node
import { describe, expect, it } from "vitest";

import { publicUrlCheck, tailscaleServeCheck, tailscaleStatusCheck, telegramAllowedUsersCheck, telegramCredentialsCheck, telegramEnabledCheck } from "@/lib/ops/doctor/checks/notify";

import { httpDown, makeContext, only, ran, SERVE_OK } from "./helpers";

describe("telegram.credentials", () => {
  it("ok when token and chat id are set and well-formed, without sending anything", async () => {
    const ctx = makeContext();
    const r = await only(telegramCredentialsCheck, ctx);
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r)).not.toContain("ABC-test_token");
    expect(ctx.probes.http).not.toHaveBeenCalled();
  });
  it("fails when neither is set while the push is switched on", async () => {
    const r = await only(telegramCredentialsCheck, makeContext({ env: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: undefined } }));
    expect(r.status).toBe("fail");
    expect(r.hint).toContain("telegram.md");
  });
  it("is fine (optional) when neither is set and the push is switched off", async () => {
    const r = await only(telegramCredentialsCheck, makeContext({ env: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: undefined }, notify: (raw) => (raw.telegram.enabled = false) }));
    expect(r.status).toBe("ok");
  });
  it("only warns about a malformed value while the push is switched off", async () => {
    const r = await only(telegramCredentialsCheck, makeContext({ env: { TELEGRAM_BOT_TOKEN: "not-a-token-at-all" }, notify: (raw) => (raw.telegram.enabled = false) }));
    expect(r.status).toBe("warn");
  });
  it("fails when only one is set, naming the variable but never its value", async () => {
    const r = await only(telegramCredentialsCheck, makeContext({ env: { TELEGRAM_CHAT_ID: "" } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("TELEGRAM_CHAT_ID");
  });
  it("fails on a malformed token without echoing it", async () => {
    const r = await only(telegramCredentialsCheck, makeContext({ env: { TELEGRAM_BOT_TOKEN: "not-a-token-at-all" } }));
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r)).not.toContain("not-a-token-at-all");
  });
});

describe("telegram.allowed_users", () => {
  it("ok for a private chat", async () => {
    expect((await only(telegramAllowedUsersCheck, makeContext())).status).toBe("ok");
  });
  it("warns for a group chat (negative id) without TELEGRAM_ALLOWED_USER_IDS", async () => {
    const r = await only(telegramAllowedUsersCheck, makeContext({ env: { TELEGRAM_CHAT_ID: "-100123456" } }));
    expect(r.status).toBe("warn");
    expect(r.hint).toContain("TELEGRAM_ALLOWED_USER_IDS");
  });
  it("ok for a group chat once the users are listed", async () => {
    const r = await only(telegramAllowedUsersCheck, makeContext({ env: { TELEGRAM_CHAT_ID: "-100123456", TELEGRAM_ALLOWED_USER_IDS: "11, 22" } }));
    expect(r).toMatchObject({ status: "ok", detail: expect.stringContaining("2") });
  });
  it("fails the credentials check, not this one, on a malformed list", async () => {
    const ctx = makeContext({ env: { TELEGRAM_ALLOWED_USER_IDS: "me" } });
    expect((await only(telegramAllowedUsersCheck, ctx)).status).toBe("ok");
    expect((await only(telegramCredentialsCheck, ctx)).status).toBe("fail");
  });
});

describe("telegram.enabled", () => {
  it("ok when notify.yaml turns it on", async () => {
    expect((await only(telegramEnabledCheck, makeContext())).status).toBe("ok");
  });
  it("is fine while telegram.enabled is false and nothing is configured", async () => {
    const r = await only(telegramEnabledCheck, makeContext({ env: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: undefined }, notify: (raw) => (raw.telegram.enabled = false) }));
    expect(r.status).toBe("ok");
  });
  it("warns when the credentials are in .env but telegram.enabled is false", async () => {
    const r = await only(telegramEnabledCheck, makeContext({ notify: (raw) => (raw.telegram.enabled = false) }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("telegram.enabled");
  });
});

describe("network.public_url", () => {
  it("ok when it answers from this machine", async () => {
    const ctx = makeContext();
    expect(await only(publicUrlCheck, ctx)).toMatchObject({ status: "ok", detail: expect.stringContaining("https://mac.example-tailnet.ts.net/api/health") });
  });
  it("warns when it is not set", async () => {
    const r = await only(publicUrlCheck, makeContext({ notify: (raw) => (raw.public_base_url = null) }));
    expect(r.status).toBe("warn");
    expect(r.hint).toContain("public_base_url");
  });
  it("fails when it does not answer", async () => {
    const r = await only(publicUrlCheck, makeContext({ urls: { "https://mac.example-tailnet.ts.net/api/health": httpDown("ENOTFOUND") } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("ENOTFOUND");
  });
  it("fails on a non-2xx answer", async () => {
    const r = await only(publicUrlCheck, makeContext({ urls: { "https://mac.example-tailnet.ts.net/api/health": { ok: false, status: 502, body: "", error: null } } }));
    expect(r.detail).toContain("502");
  });
});

describe("tailscale.status", () => {
  it("ok with the machine name", async () => {
    expect(await only(tailscaleStatusCheck, makeContext())).toMatchObject({ status: "ok", detail: "已连接（mac.example-tailnet.ts.net）" });
  });
  it("warns when stopped", async () => {
    const r = await only(tailscaleStatusCheck, makeContext({ commands: { "tailscale status --json": ran('Warning: client version mismatch\n{"BackendState":"Stopped"}') } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("Stopped");
    expect(r.hint).toContain("Connect");
  });
  it("warns when the command is missing, hangs or prints junk", async () => {
    expect((await only(tailscaleStatusCheck, makeContext({ commands: { "tailscale status --json": { kind: "missing" } } }))).status).toBe("warn");
    expect((await only(tailscaleStatusCheck, makeContext({ commands: { "tailscale status --json": { kind: "timeout" } } }))).status).toBe("warn");
    expect((await only(tailscaleStatusCheck, makeContext({ commands: { "tailscale status --json": ran("junk") } }))).status).toBe("warn");
  });
});

describe("tailscale.serve", () => {
  const serve = (json: string) => makeContext({ commands: { "tailscale serve status --json": ran(json) } });
  it("ok when serve proxies to the web port and funnel is off", async () => {
    expect(await only(tailscaleServeCheck, makeContext())).toMatchObject({ status: "ok", detail: expect.stringContaining("端口 3000") });
  });
  it("warns when there is no serve rule", async () => {
    const r = await only(tailscaleServeCheck, serve("{}"));
    expect(r.status).toBe("warn");
    expect(r.hint).toContain("tailscale serve --bg 3000");
  });
  it("warns when serve points at another port", async () => {
    const other = JSON.stringify({ Web: { "mac:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } });
    const r = await only(tailscaleServeCheck, serve(other));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("9999");
  });
  it("fails when funnel exposes it to the internet (C5)", async () => {
    const funnel = JSON.stringify({ ...JSON.parse(SERVE_OK), AllowFunnel: { "mac.example-tailnet.ts.net:443": true } });
    const r = await only(tailscaleServeCheck, serve(funnel));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("Funnel");
    expect(r.hint).toContain("tailscale serve reset");
  });
  it("does not mind funnel entries that are false", async () => {
    const quiet = JSON.stringify({ ...JSON.parse(SERVE_OK), AllowFunnel: { "mac.example-tailnet.ts.net:443": false } });
    expect((await only(tailscaleServeCheck, serve(quiet))).status).toBe("ok");
  });
  it("warns when tailscale is not running, so serve cannot be read", async () => {
    const ctx = makeContext({ commands: { "tailscale status --json": ran('{"BackendState":"Stopped"}') } });
    expect((await only(tailscaleServeCheck, ctx)).status).toBe("warn");
    expect(ctx.probes.run.mock.calls.some((c) => c[1].includes("serve"))).toBe(false);
  });
  it("follows the port of doctor.web_url", async () => {
    const ctx = makeContext({ settings: { web_url: "http://127.0.0.1:3200" } });
    expect((await only(tailscaleServeCheck, ctx)).status).toBe("warn");
  });
});
