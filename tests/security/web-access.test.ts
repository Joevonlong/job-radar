// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isLockedOut, showAccessBanner, showSignOut, type WebAccess } from "@/lib/security/web-access";

const access = (extra: Partial<WebAccess>): WebAccess => ({ password: null, localRequest: true, localExempt: true, bindLoopback: true, sessionValid: false, ...extra });
const PASSWORD = { kind: "plain", plain: "a long test password" } as const;

describe("what the shell shows", () => {
  it("no password, opened on this machine, loopback bind: nothing", () => {
    const a = access({});
    expect([showAccessBanner(a), showSignOut(a), isLockedOut(a)]).toEqual([false, false, false]);
  });

  it("no password, reached from elsewhere (tailscale serve) or published beyond loopback: the warning banner", () => {
    expect(showAccessBanner(access({ localRequest: false, localExempt: false }))).toBe(true);
    expect(showAccessBanner(access({ bindLoopback: false, localExempt: false }))).toBe(true);
  });

  it("with a password: locked without a session, sign-out with one, neither for a local request", () => {
    expect(isLockedOut(access({ password: PASSWORD, localRequest: false, localExempt: false }))).toBe(true);
    const signedIn = access({ password: PASSWORD, localRequest: false, localExempt: false, sessionValid: true });
    expect([showAccessBanner(signedIn), showSignOut(signedIn), isLockedOut(signedIn)]).toEqual([false, true, false]);
    const local = access({ password: PASSWORD });
    expect([showSignOut(local), isLockedOut(local)]).toEqual([false, false]);
  });
});
