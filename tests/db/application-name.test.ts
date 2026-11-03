// @vitest-environment node
import { describe, expect, it } from "vitest";

import { applicationName, instanceApplicationName } from "@/lib/db/instance-lock";

const PRINTABLE_ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) => String.fromCharCode(0x20 + index)).join("");

describe("applicationName: the host in a Postgres application_name", () => {
  it("is `job-radar <name> pid=<pid> host=<host>` for a plain host", () => {
    expect(applicationName("config-write", 4242, "build-1.local")).toBe("job-radar config-write pid=4242 host=build-1.local");
  });

  it("leaves every printable ASCII character of the host unchanged", () => {
    // in pieces short enough not to meet the length limit
    for (let start = 0; start < PRINTABLE_ASCII.length; start += 30) {
      const host = PRINTABLE_ASCII.slice(start, start + 30);
      expect(applicationName("x", 1, host)).toBe(`job-radar x pid=1 host=${host}`);
    }
  });

  it.each([
    ["accented letters", "mäcbook-é", "m%c3%a4cbook-%c3%a9"],
    ["Chinese", "电脑-1", "%e7%94%b5%e8%84%91-1"],
    ["a tab", "my\tx", "my%09x"],
    ["a control character and DEL", "a\u0000b\u007fc", "a%00b%7fc"],
    ["a character outside the BMP (one character, all its bytes)", "h😀h", "h%f0%9f%98%80h"],
    ["a non-breaking space", "a\u00a0b", "a%c2%a0b"],
  ])("writes every character that is not printable ASCII as its UTF-8 bytes: %s", (_name, host, expected) => {
    expect(applicationName("x", 1, host)).toBe(`job-radar x pid=1 host=${expected}`);
  });

  it("never exceeds the 63 bytes Postgres shows, however long the host", () => {
    for (const host of ["h".repeat(300), "电".repeat(300), "😀".repeat(300), ""]) {
      expect(applicationName("config-write", 2_147_483_647, host).length).toBeLessThanOrEqual(63);
    }
    expect(applicationName("x", 1, "h".repeat(300))).toHaveLength(63);
  });

  it("reads back exactly: its UTF-8 length is its string length", () => {
    for (const host of ["mäcbook", "电脑", "😀", PRINTABLE_ASCII.slice(0, 30), "h".repeat(100), "a b\u0000c"]) {
      const name = applicationName("ai-worker", 99, host);
      expect(Buffer.byteLength(name, "utf8")).toBe(name.length);
      expect(/^[\x20-\x7e]*$/.test(name)).toBe(true);
    }
  });

  it("defaults to this process", () => {
    const name = applicationName("x");
    expect(name.startsWith(`job-radar x pid=${process.pid} host=`)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("instanceApplicationName is the same format (the release evidence check compares with it)", () => {
    for (const host of ["mäcbook", "plain", "h".repeat(200)]) expect(instanceApplicationName("ai-worker", 7, host)).toBe(applicationName("ai-worker", 7, host));
  });
});
