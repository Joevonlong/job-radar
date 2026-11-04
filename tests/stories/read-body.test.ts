// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readBody } from "@/lib/stories/read-body";

const request = (body: ReadableStream<Uint8Array>) => new Request("http://127.0.0.1/x", { method: "POST", body, duplex: "half" } as RequestInit);

describe("readBody", () => {
  it("reads a body that arrives in time and refuses one that is too long", async () => {
    expect(await readBody(new Request("http://127.0.0.1/x", { method: "POST", body: "hello" }), 100, 1000)).toEqual(new TextEncoder().encode("hello"));
    expect(await readBody(new Request("http://127.0.0.1/x", { method: "POST", body: "hello" }), 3, 1000)).toBeNull();
  });

  it("cuts off a sender that does not finish within the time limit", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode("a")) });
    expect(await readBody(request(stalled), 100, 50)).toBe("timeout");
  });
});
