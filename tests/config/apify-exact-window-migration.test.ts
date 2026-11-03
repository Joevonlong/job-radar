// @vitest-environment node
/**
 * sources.yaml 7 -> 8: only the old shipped Apify template of the default actor changes.
 */
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { sources008 } from "@/lib/config/migrations/sources/008-apify-exact-window";
import { CONFIG_YAML_OPTIONS } from "@/lib/config/yaml-options";

const file = (template: string, actor = "valig/linkedin-jobs-scraper"): string => `config_version: 7
linkedin:
  apify:
    actor_id: ${actor}
    # my note
    input_template:
${template}
    remote_input:
      urlParam:
        - { key: f_WT, value: "2" }
`;

const OLD = `      keywords: "{keywords}"
      location: "{location}"
      datePosted: "{date_posted}"
      limit: "{limit}"`;

function run(text: string): { text: string; value: { linkedin?: { apify?: Record<string, unknown> } } } {
  const doc = parseDocument(text, CONFIG_YAML_OPTIONS);
  sources008.migrate(doc);
  return { text: doc.toString(), value: doc.toJS() };
}

describe("sources.yaml 7 -> 8", () => {
  it("replaces datePosted with the exact window in an unedited template, in place, comments kept", () => {
    const { text, value } = run(file(OLD));
    expect(value.linkedin?.apify?.input_template).toEqual({
      keywords: "{keywords}",
      location: "{location}",
      urlParam: [{ key: "f_TPR", value: "r{posted_within_seconds}" }],
      limit: "{limit}",
    });
    expect(Object.keys(value.linkedin?.apify?.input_template as object)).toEqual(["keywords", "location", "urlParam", "limit"]);
    expect(text).toContain("# my note");
    expect(text).toContain('- { key: f_TPR, value: "r{posted_within_seconds}" }');
    expect(value.linkedin?.apify?.remote_input).toEqual({ urlParam: [{ key: "f_WT", value: "2" }] });
  });

  it("treats a template with its keys in another order as unedited", () => {
    const reordered = OLD.split("\n").reverse().join("\n");
    expect(run(file(reordered)).value.linkedin?.apify?.input_template).toHaveProperty("urlParam");
  });

  it.each([
    ["a changed value", OLD.replace("{limit}", "50")],
    ["an added key", `${OLD}\n      easyApply: true`],
    ["a removed key", OLD.replace('      datePosted: "{date_posted}"\n', "")],
  ])("leaves a template with %s alone", (_name, template) => {
    const before = file(template);
    expect(run(before).text).toBe(before);
  });

  it("leaves the template of another actor alone", () => {
    const before = file(OLD, "someone/another-actor");
    expect(run(before).text).toBe(before);
  });

  it("leaves the template alone when date_posted was edited, the new template would not read it", () => {
    const before = file(OLD).replace("    # my note\n", '    date_posted: { day: day, week: week, month: month, any: "" }\n    # my note\n');
    expect(run(before).text).toBe(before);
  });

  it("migrates next to the old shipped date_posted", () => {
    const before = file(OLD).replace("    # my note\n", '    date_posted: { day: r86400, week: r604800, month: r2592000, any: "" }\n    # my note\n');
    expect(run(before).value.linkedin?.apify?.input_template).toHaveProperty("urlParam");
  });

  it("migrates a template without an actor_id, the default actor is inherited", () => {
    const { value } = run(file(OLD).replace("    actor_id: valig/linkedin-jobs-scraper\n", ""));
    expect(value.linkedin?.apify?.input_template).toHaveProperty("urlParam");
  });

  it("does nothing without a template (a smaller file follows the shipped one)", () => {
    const before = "config_version: 7\nlinkedin:\n  apify:\n    enabled: false\n";
    expect(run(before).text).toBe(before);
  });
});
