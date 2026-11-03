import type { Document } from "yaml";

/** What a step after the overlay format gets besides the document. */
export interface MigrationContext {
  /** The shipped file's document, read-only. Absent for a step before the overlay format. */
  readonly shipped?: Document;
}

/**
 * One step of a config file's format history: turns a document at version `from` into one at version `to`.
 *
 * Contract:
 * - `to === from + 1`; the steps of a file form a chain 1 → 2 → 3 … (checked at load, see `assertMigrationChain`).
 * - `migrate` edits the parsed YAML `Document` in place (`doc.get`, `doc.set`, `doc.setIn`, `doc.delete`, `doc.createNode`,
 *   node edits). Edit nodes rather than rebuilding the document, so the user's comments survive. It must not do I/O and
 *   must be deterministic. It must not touch `config_version`: the runner stamps `to` after the step.
 * - It runs on the user's real file, which may lack keys the shipped default has or carry extra ones: tolerate both.
 *   Validation happens after the whole chain ran (the result must pass the file's current zod schema).
 *
 * Where: `src/lib/config/migrations/<file>/NNN-slug.ts` (`<file>` = the YAML file name without `.yaml`, e.g.
 * `interests/002-signal-categories.ts` for interests.yaml 1 → 2), exported and listed in `migrations/index.ts`.
 * The file's current version is the `to` of its last step (1 when it has none).
 *
 * The `overlay-format` step (`convertOnly`) splits a chain in two. Steps before it edit a whole file. Steps after it edit
 * an overlay, which holds only the user's changes, so a key may be absent because it follows the shipped file: they get
 * the shipped document read-only (`context.shipped`) to tell the two apart, and they must not write to it.
 */
export interface ConfigMigration {
  /** Version the document has before this step. */
  readonly from: number;
  /** Version after this step: always `from + 1`. */
  readonly to: number;
  /** One line for `pnpm config:migrate` (what changes and why). Optional. */
  readonly description?: string;
  /**
   * Run only by `config:migrate --write --convert-overlays`: the loader, the writer and a plain `--write` stop before it,
   * and the file stays in the whole-file format at the step's `from`.
   */
  readonly convertOnly?: boolean;
  /** Rewrite the document in place (see the contract above). */
  migrate(doc: Document, context?: MigrationContext): void;
}
