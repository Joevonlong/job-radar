import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: vi.fn(), warn: vi.fn() }));

vi.mock("@/lib/jobs/search", () => ({ jobSearchSettings: state.settings }));
vi.mock("@/lib/logging/process-logger", () => ({
  createProcessLogger: () => ({ warn: state.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() }),
}));

beforeEach(() => {
  vi.resetModules();
  state.settings.mockReset();
  state.warn.mockReset();
});

describe("paletteMinChars", () => {
  it("reads the configured minimum", async () => {
    state.settings.mockReturnValue({ palette: { min_chars: 4 } });
    const { paletteMinChars } = await import("@/components/shell/topbar");
    expect(paletteMinChars()).toBe(4);
    expect(state.warn).not.toHaveBeenCalled();
  });

  it("falls back to the shipped default and warns once when job-search.yaml cannot be loaded", async () => {
    state.settings.mockImplementation(() => {
      throw new Error("job-search.yaml: palette.min_chars must be at most 10");
    });
    const { paletteMinChars } = await import("@/components/shell/topbar");
    expect(paletteMinChars()).toBe(2);
    expect(paletteMinChars()).toBe(2);
    expect(state.warn).toHaveBeenCalledTimes(1);
    expect(state.warn.mock.calls[0]?.[1]).toMatchObject({ fallback: 2, error: expect.stringContaining("min_chars") });
  });
});
