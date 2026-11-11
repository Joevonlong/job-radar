import { describe, expect, it } from "vitest";

import { accessFromToolSwitches } from "@/lib/agent-access/grants";
import { mcpSchema } from "@/lib/config/schemas/mcp";

describe("accessFromToolSwitches", () => {
  it("maps defaults to jobs and tracking reads for both the matrix and stdio", () => {
    const access = accessFromToolSwitches(mcpSchema.parse({}));
    expect(access.enabled).toBe(false);
    expect([...access.matrix]).toEqual(["jobs:read", "tracking:read"]);
    expect([...access.stdio]).toEqual([...access.matrix]);
    expect(access.switchedOff("get_application_context")).toBe(true);
    expect(access.switchedOff("save_application_answer")).toBe(true);
    expect(access.switchedOff("search_jobs")).toBe(false);
  });

  it("keeps jobs read when search is on and get job is off", () => {
    const access = accessFromToolSwitches(mcpSchema.parse({ enabled: true, tools: { get_job: false } }));
    expect(access.enabled).toBe(true);
    expect(access.matrix.has("jobs:read")).toBe(true);
    expect(access.switchedOff("get_job")).toBe(true);
    expect(access.switchedOff("search_jobs")).toBe(false);
  });

  it("also derives jobs read from get job on its own", () => {
    const access = accessFromToolSwitches(mcpSchema.parse({ tools: { search_jobs: false, get_job: true } }));
    expect(access.matrix.has("jobs:read")).toBe(true);
    expect(access.switchedOff("search_jobs")).toBe(true);
  });

  it("removes jobs read only when both job tools are off", () => {
    const access = accessFromToolSwitches(mcpSchema.parse({ tools: { search_jobs: false, get_job: false } }));
    expect([...access.matrix]).toEqual(["tracking:read"]);
  });

  it("removes tracking read when list applications is off", () => {
    const access = accessFromToolSwitches(mcpSchema.parse({ tools: { list_applications: false } }));
    expect([...access.matrix]).toEqual(["jobs:read"]);
    expect(access.switchedOff("list_applications")).toBe(true);
  });

  it.each([
    [true, false, ["writer:read"]],
    [false, true, ["writer:write"]],
    [true, true, ["writer:read", "writer:write"]],
  ])("maps writer read=%s and write=%s separately", (read, write, expected) => {
    const access = accessFromToolSwitches(mcpSchema.parse({ tools: { get_application_context: read, save_application_answer: write } }));
    expect([...access.matrix]).toEqual(["jobs:read", "tracking:read", ...expected]);
    expect([...access.stdio]).toEqual([...access.matrix]);
  });

  it("never switches off unknown capability ids", () => {
    const access = accessFromToolSwitches(mcpSchema.parse({}));
    expect(access.switchedOff("future_job_tool")).toBe(false);
    expect(access.switchedOff("toString")).toBe(false);
  });
});
