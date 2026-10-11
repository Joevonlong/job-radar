// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isNonPublicAddress, publicUrlProblem } from "@/lib/net/public-url";

describe("isNonPublicAddress", () => {
  it.each(["0.0.0.0", "10.1.2.3", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "nonsense", "::127.0.0.1", "::7f00:1", "::a00:1", "::ffff:0:127.0.0.1", "::ffff:0:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:c0a8:101::", "64:ff9b::a00:1", "64:ff9b:1::1", "fec0::1", "2001:0:4136:e378::1", "1:2:3"])(
    "%s is not public",
    (address) => expect(isNonPublicAddress(address)).toBe(true),
  );
  it.each(["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8", "::8.8.8.8", "::ffff:0:8.8.8.8", "2002:808:808::1", "2a00:1450:4001:80b::200e"])("%s is public", (address) =>
    expect(isNonPublicAddress(address)).toBe(false),
  );
});

describe("publicUrlProblem", () => {
  const resolve = async () => ["93.184.216.34"];
  it("allows an http(s) URL on a public name or address", async () => {
    expect(await publicUrlProblem("https://jobs.example.test/1?q=1", resolve)).toBeNull();
    expect(await publicUrlProblem("http://93.184.216.34/", resolve)).toBeNull();
  });
  it("names the reason otherwise", async () => {
    expect(await publicUrlProblem("ftp://a.example.test/", resolve)).toBe("scheme");
    expect(await publicUrlProblem("https://u:p@a.example.test/", resolve)).toBe("credentials");
    expect(await publicUrlProblem("http://jobspy:8000/", resolve)).toBe("host");
    expect(await publicUrlProblem("http://localhost/", resolve)).toBe("host");
    expect(await publicUrlProblem("http://127.0.0.1/", resolve)).toBe("address");
    expect(await publicUrlProblem("http://a.example.test/", async () => ["127.0.0.1"])).toBe("address");
    expect(await publicUrlProblem("http://a.example.test/", async () => [])).toBe("unresolved");
    expect(await publicUrlProblem("not a url", resolve)).toBe("host");
  });
});
