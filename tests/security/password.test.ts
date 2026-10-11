// @vitest-environment node
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashPassword, parsePasswordHash, passwordVersion, plainPasswordLength, readPasswordSetting, verifyPassword } from "@/lib/security/password";

describe("password hashing", () => {
  it("writes scrypt N=2^17, r=8, p=1 with a 16-byte salt and a 32-byte key, without `$` or spaces", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt:131072:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(hash).not.toContain("$");
    const parsed = parsePasswordHash(hash);
    expect(parsed?.salt.length).toBe(16);
    expect(parsed?.key.length).toBe(32);
    // a fresh salt every time
    expect(await hashPassword("correct horse battery")).not.toBe(hash);
  });

  it("verifies the right password and refuses a wrong one", async () => {
    const setting = readPasswordSetting({ JOB_RADAR_WEB_PASSWORD_HASH: await hashPassword("correct horse battery") });
    expect(setting?.kind).toBe("hash");
    if (setting === null) throw new Error("no setting");
    expect(await verifyPassword("correct horse battery", setting)).toBe(true);
    expect(await verifyPassword("correct horse batterY", setting)).toBe(false);
    expect(await verifyPassword("", setting)).toBe(false);
  });

  it("plain text: compares in constant time (both sides hashed), the hash wins when both are set", async () => {
    const plain = readPasswordSetting({ JOB_RADAR_WEB_PASSWORD: "letmein-please" });
    if (plain === null) throw new Error("no setting");
    expect(plain.kind).toBe("plain");
    expect(await verifyPassword("letmein-please", plain)).toBe(true);
    expect(await verifyPassword("letmein-pleasE", plain)).toBe(false);
    expect(await verifyPassword("letmein", plain)).toBe(false);
    expect(plainPasswordLength(plain)).toBe(14);
    const both = readPasswordSetting({ JOB_RADAR_WEB_PASSWORD: "x", JOB_RADAR_WEB_PASSWORD_HASH: await hashPassword("other one!") });
    expect(both?.kind).toBe("hash");
  });

  it("no variable or empty ones: no password", () => {
    expect(readPasswordSetting({})).toBeNull();
    expect(readPasswordSetting({ JOB_RADAR_WEB_PASSWORD: "", JOB_RADAR_WEB_PASSWORD_HASH: "  " })).toBeNull();
  });

  it("a malformed hash stays configured (the gate stays shut) and matches nothing", async () => {
    const setting = readPasswordSetting({ JOB_RADAR_WEB_PASSWORD_HASH: "$2b$10$notours" });
    expect(setting).toMatchObject({ kind: "hash", parsed: null });
    if (setting === null) throw new Error("no setting");
    expect(await verifyPassword("$2b$10$notours", setting)).toBe(false);
  });

  it.each([
    ["wrong prefix", "bcrypt:16384:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA"],
    ["N not a power of two", "scrypt:1000:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA"],
    ["too much memory", "scrypt:4194304:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA"],
    ["short salt", "scrypt:16384:8:1:AAAA:AAAAAAAAAAAAAAAAAAAAAA"],
    ["not base64url", "scrypt:16384:8:1:AAAA$AAAAAAA:AAAAAAAAAAAAAAAAAAAAAA"],
    ["missing part", "scrypt:16384:8:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA"],
  ])("refuses a hash with %s", (_name, text) => {
    expect(parsePasswordHash(text)).toBeNull();
  });

  it("the password fingerprint is an HMAC with the session secret: it changes with the password and with the secret", () => {
    const secret = randomBytes(32);
    const a = passwordVersion({ kind: "plain", plain: "one password" }, secret);
    expect(passwordVersion({ kind: "plain", plain: "one password" }, secret)).toBe(a);
    expect(passwordVersion({ kind: "plain", plain: "another one" }, secret)).not.toBe(a);
    expect(passwordVersion({ kind: "plain", plain: "one password" }, randomBytes(32))).not.toBe(a);
  });
});
