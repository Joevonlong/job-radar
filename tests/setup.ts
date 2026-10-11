import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

import { UNREACHABLE_DATABASE_URL } from "@/lib/db/test-guard";

// Unit tests have no database. Without this a test that reaches getDb() would use the compose default and write to the real
// database; the guard in createConnection refuses it as well, this keeps the URL unreachable even outside that path.
if ((process.env.DATABASE_URL ?? "").trim() === "") process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;

afterEach(() => {
  cleanup();
});

// waitFor/findBy* default to 1 s; under heavy machine load a render can take longer than that.
configure({ asyncUtilTimeout: 10_000 });

// jsdom has no ResizeObserver; Radix controls that measure themselves (Switch) need one to exist.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
