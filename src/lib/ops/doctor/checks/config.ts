/** `config.layers`: the user config directory and the shipped defaults under it. `i18n.config`: the languages. */
import { LOCALE_META, isLocale } from "@/i18n/locale";
import { displayLanguageName } from "@/lib/i18n/languages";

import { fail, joinList, merge, ok, warn, type Piece } from "../helpers";
import type { DoctorCheck, DoctorContext } from "../types";

const spec = { id: "config.layers", group: "data" } as const;

const LIST_LIMIT = 5;

/** The first few items of a list for a one-line report; `…` when there are more. */
function listSome(ctx: DoctorContext, items: readonly string[]): string {
  return joinList(ctx, items.slice(0, LIST_LIMIT)) + (items.length > LIST_LIMIT ? "…" : "");
}

export const configLayersCheck: DoctorCheck = {
  ...spec,
  async run(ctx) {
    const { t } = ctx;
    const state = await ctx.probes.configLayers();
    if (!state.userDirExists) {
      return fail(spec, t("checks.config.layers.noUserDir", { userDir: state.userDir, defaultsDir: state.defaultsDir }), t("checks.config.layers.noUserDirHint"));
    }
    if (state.userDirWritable === false) {
      return fail(spec, t("checks.config.layers.notWritable", { userDir: state.userDir }), t("checks.config.layers.notWritableHint", { userDir: state.userDir }));
    }
    const pieces: Piece[] = [];
    if (state.problems.length > 0) {
      pieces.push({
        status: "fail",
        detail: t("checks.config.layers.problems", { files: joinList(ctx, state.problems.map((p) => t("checks.config.layers.problem", { file: p.file, message: p.message }))) }),
        hint: t("checks.config.layers.problemsHint"),
      });
    }
    if (state.pendingMigrations.length > 0) {
      pieces.push({
        status: "warn",
        detail: t("checks.config.layers.pendings", { files: joinList(ctx, state.pendingMigrations.map((p) => t("checks.config.layers.pending", { file: p.file, from: p.from, to: p.to }))) }),
        hint: t("checks.config.layers.pendingsHint"),
      });
    }
    if (state.missingVersion.length > 0) {
      pieces.push({ status: "warn", detail: t("checks.config.layers.missingVersion", { files: joinList(ctx, state.missingVersion) }), hint: t("checks.config.layers.missingVersionHint") });
    }
    if (state.notCopied.length > 0) {
      pieces.push({ status: "warn", detail: t("checks.config.layers.notCopied", { files: joinList(ctx, state.notCopied) }), hint: t("checks.config.layers.notCopiedHint") });
    }
    const overlays = state.overlays.filter((file) => file.format === "overlay");
    const info: Piece[] = [];
    const invalid = overlays.flatMap((file) => file.entries.filter((entry) => entry.invalid).map((entry) => `${file.file} ${entry.path}`));
    if (invalid.length > 0) {
      // harmless (a typo, or a key a product update removed): said, never a warning
      info.push({ status: "ok", detail: t("checks.config.layers.invalidUnsets", { count: invalid.length, keys: listSome(ctx, invalid) }) });
    }
    const summary =
      overlays.length === 0
        ? t("checks.config.layers.summary", { userDir: state.userDir, count: state.userFiles, defaultsDir: state.defaultsDir })
        : t("checks.config.layers.summaryOverlay", {
            userDir: state.userDir,
            count: state.userFiles,
            overrides: overlays.reduce((sum, file) => sum + file.overrides, 0),
            unsets: overlays.reduce((sum, file) => sum + file.unsets, 0),
            defaultsDir: state.defaultsDir,
          });
    // A pin equal to the shipped value is a choice, not a problem: it is said, never warned about.
    const pins = overlays.flatMap((file) => file.entries.filter((entry) => entry.pin).map((entry) => `${file.file} ${entry.path}`));
    if (pins.length > 0) info.push({ status: "ok", detail: t("checks.config.layers.pins", { keys: listSome(ctx, pins) }) });
    if (pieces.length === 0) return info.length === 0 ? ok(spec, summary) : merge(ctx, spec, [{ status: "ok", detail: summary }, ...info]);
    return merge(ctx, spec, [...pieces, { status: "ok", detail: summary }, ...info]);
  },
};

const i18nSpec = { id: "i18n.config", group: "stack" } as const;

/** A language for people: an interface language by its own name (`中文`), any other by its name in the report's language. */
function languageLabel(ctx: DoctorContext, code: string): string {
  return isLocale(code) ? `${LOCALE_META[code].name} (${code})` : `${displayLanguageName(code, ctx.locale)} (${code})`;
}

/** What language.yaml says (interface, AI output, translation target, Telegram, command line). */
export const languageConfigCheck: DoctorCheck = {
  ...i18nSpec,
  async run(ctx) {
    const { t } = ctx;
    const language = ctx.config.language;
    if (language === null) return warn(i18nSpec, t("checks.i18n.config.unreadable", { problem: ctx.config.languageProblem ?? t("common.unknown") }), t("checks.i18n.config.unreadableHint"));
    const ui = language.ui.default_locale;
    const also = language.ai.summary_also;
    return ok(
      i18nSpec,
      t("checks.i18n.config.summary", {
        ui: languageLabel(ctx, ui),
        ai: languageLabel(ctx, language.ai.output),
        also: also.length === 0 ? "" : t("checks.i18n.config.summaryAlso", { languages: joinList(ctx, also.map((code) => languageLabel(ctx, code))) }),
        translation: languageLabel(ctx, language.translation.target),
        notify: languageLabel(ctx, language.notify.locale ?? ui),
        cli: languageLabel(ctx, language.cli.locale ?? ui),
      }),
    );
  },
};

const marketSpec = { id: "config.market", group: "data" } as const;

/** The market resolves (else every market step is skipped), and what it is. */
export const configMarketCheck: DoctorCheck = {
  ...marketSpec,
  async run(ctx) {
    const { t } = ctx;
    const result = await ctx.probes.market();
    if (!result.ok) return fail(marketSpec, t("checks.config.market.unresolved", { reason: result.reason }), t("checks.config.market.unresolvedHint"));
    const s = result.summary;
    const summary = t(s.languageStep ? "checks.config.market.summaryStepOn" : "checks.config.market.summaryStepOff", { pack: s.packId, country: s.country, currency: s.currency, language: s.homeLanguage });
    const pieces: Piece[] = [];
    if (s.packLayer === "user") {
      pieces.push({ status: "warn", detail: t("checks.config.market.userPack", { pack: s.packId, dir: s.packDir }), hint: t("checks.config.market.userPackHint") });
    }
    if (s.channels !== null && s.channels.running.length === 0) {
      pieces.push({ status: "warn", detail: t("checks.config.market.noChannels"), hint: t("checks.config.market.noChannelsHint") });
    }
    if (s.channels !== null && s.channels.otherMarket.length > 0) {
      pieces.push({ status: "ok", detail: t("checks.config.market.otherMarket", { ids: joinList(ctx, s.channels.otherMarket.map((c) => c.id)) }) });
    }
    if (pieces.every((p) => p.status === "ok")) return merge(ctx, marketSpec, [{ status: "ok", detail: summary }, ...pieces]);
    return merge(ctx, marketSpec, [...pieces, { status: "ok", detail: summary }]);
  },
};

const pendingSpec = { id: "config.pending", group: "data" } as const;

/** What a deploy's write step would still do, and why the last deploy left it (`CONFIG_PENDING_REASON`, set by deploy.sh). */
export const configPendingCheck: DoctorCheck = {
  ...pendingSpec,
  async run(ctx) {
    const { t } = ctx;
    const plan = await ctx.probes.configWrites();
    if (plan.writes.length === 0 && plan.problems.length === 0) return ok(pendingSpec, t("checks.config.pending.none"));
    const reason = ctx.env.CONFIG_PENDING_REASON?.trim() ?? "";
    const pieces: Piece[] = [];
    if (plan.writes.length > 0) {
      const files = plan.writes.map((write) => t(`checks.config.pending.kind.${write.kind}`, { file: write.name }));
      pieces.push({ status: "warn", detail: t("checks.config.pending.pending", { count: plan.writes.length, files: joinList(ctx, files) }), hint: t("checks.config.pending.hint") });
    }
    if (plan.problems.length > 0) pieces.push({ status: "warn", detail: t("checks.config.pending.problems", { count: plan.problems.length, files: joinList(ctx, plan.problems.map((problem) => problem.name)) }), hint: t("checks.config.pending.hint") });
    if (reason !== "") pieces.push({ status: "warn", detail: t("checks.config.pending.skipped", { reason }) });
    return merge(ctx, pendingSpec, pieces);
  },
};

export const CONFIG_CHECKS: readonly DoctorCheck[] = [configLayersCheck, configMarketCheck, configPendingCheck];
export const LANGUAGE_CHECKS: readonly DoctorCheck[] = [languageConfigCheck];
