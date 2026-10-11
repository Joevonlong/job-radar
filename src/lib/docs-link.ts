/**
 * The upstream repository. `next.config.ts` sets NEXT_PUBLIC_SOURCE_URL from `repository.url` in package.json (a fork changes it
 * there), so the client bundle does not carry package.json. The default is for runs without Next (unit tests, scripts);
 * `tests/docs-link.test.ts` checks that it equals package.json.
 */
export const DEFAULT_SOURCE_URL = "https://github.com/Joevonlong/job-radar";
export const SOURCE_URL = process.env.NEXT_PUBLIC_SOURCE_URL ?? DEFAULT_SOURCE_URL;

/** The release tag of a version (`v2.0.0`): every release is tagged so on the repository. */
export function sourceRefFor(version: string): string {
  return `v${version}`;
}

/**
 * The git ref the guide links point at: the tag of the running version, which `next.config.ts` sets from package.json
 * (NEXT_PUBLIC_SOURCE_REF). Runs without Next (unit tests, scripts) fall back to `main`.
 */
export const SOURCE_REF = process.env.NEXT_PUBLIC_SOURCE_REF ?? "main";

/**
 * The guide sections the interface links to. `file` is the Markdown file in `docs/` (the Chinese counterpart is
 * `<file>.zh.md`); `anchor` is the GitHub heading slug per language (`tests/docs-link.test.ts` checks that the heading exists).
 */
export const DOC_LINKS = {
  /** The risk of scraping and account-automation channels, and how to switch them on. */
  scraping: { file: "sources", anchor: { en: "scraping", zh: "抓取" } },
  /** Which AI providers can receive job text, and in which order they are tried. */
  aiProviders: { file: "ai-providers", anchor: { en: "which-providers-receive-job-text", zh: "哪些-provider-会收到岗位文本" } },
} as const;

export type DocKey = keyof typeof DOC_LINKS;

/**
 * The GitHub URL of a guide section in the interface language (Chinese has its own file; every other language reads the
 * English one), at the running version's tag.
 */
export function docsUrl(locale: string, key: DocKey, ref: string = SOURCE_REF): string {
  const doc = DOC_LINKS[key];
  const zh = locale === "zh";
  return `${SOURCE_URL}/blob/${ref}/docs/${doc.file}${zh ? ".zh" : ""}.md#${zh ? doc.anchor.zh : doc.anchor.en}`;
}
