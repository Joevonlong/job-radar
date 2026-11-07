import { afterEach, expect, test } from "vitest";
import { POST as prepare } from "@/app/api/career/tailor/prepare/route";
import { POST as enqueue } from "@/app/api/career/tailor/route";
import { POST as actions } from "@/app/api/career/tailor/actions/route";
import { GET as status } from "@/app/api/career/tailor/status/route";
import { GET as proposals } from "@/app/api/career/tailor/proposals/route";
import { tempCareer } from "./fixtures";

let temp: ReturnType<typeof tempCareer>;
afterEach(() => temp?.cleanup());
test.each([prepare, enqueue, actions, status, proposals])("tailoring routes fail closed before reading requests", async (route) => {
  temp = tempCareer({ enabled: false });
  const result = await route(new Request("http://127.0.0.1/api/career/tailor", { method: "POST", body: "private invalid body" }));
  expect(result.status).toBe(409);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect(await result.json()).toEqual({ ok: false, error: "disabled" });
});
