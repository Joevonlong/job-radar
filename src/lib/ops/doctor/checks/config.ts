/** `config.layers`: the user config directory and the shipped defaults it overrides. `i18n.config`: the languages. */
import { LOCALE_META, isLocale } from "@/i18n/locale";
import { displayLanguageName } from "@/lib/i18n/languages";

import { fail, joinList, merge, ok, warn, type Piece } from "../helpers";
import type { DoctorCheck, DoctorContext } from "../types";

const spec = { id: "config.layers", group: "data" } as const;

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
    if (state.overrides.length > 0) {
      pieces.push({ status: "warn", detail: t("checks.config.layers.overrides", { files: joinList(ctx, state.overrides) }), hint: t("checks.config.layers.overridesHint", { userDir: state.userDir }) });
    }
    if (state.notCopied.length > 0) {
      pieces.push({ status: "warn", detail: t("checks.config.layers.notCopied", { files: joinList(ctx, state.notCopied) }), hint: t("checks.config.layers.notCopiedHint") });
    }
    const summary = t("checks.config.layers.summary", { userDir: state.userDir, count: state.userFiles, defaultsDir: state.defaultsDir });
    if (pieces.length === 0) return ok(spec, summary);
    return merge(ctx, spec, [...pieces, { status: "ok", detail: summary }]);
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

const freezeSpec = { id: "config.freeze", group: "data" } as const;

export const configFreezeCheck: DoctorCheck = {
  ...freezeSpec,
  async run(ctx) {
    const { t } = ctx;
    const pieces: Piece[] = [];
    if (!await ctx.probes.configFrozen()) pieces.push({ status: "ok", detail: t("checks.config.freeze.none") });
    else {
      const lock = await ctx.probes.releasesLock(ctx.appRoot);
      const active = lock.present && (lock.records.some((entry) => entry.kind === "record" && entry.alive) ||
        (lock.owner !== null && lock.owner.token === ctx.env.JOB_RADAR_RELEASES_LOCK_TOKEN));
      pieces.push(active ? { status: "ok", detail: t("checks.config.freeze.active") } :
        { status: "warn", detail: t("checks.config.freeze.leftover"), hint: t("checks.config.freeze.hint") });
    }
    const locks = await ctx.probes.staleConfigWriteLocks(ctx.config.schedule.deploy.config_write_lock_stale_seconds);
    if (locks.length > 0) pieces.push({ status: "warn", detail: t("checks.config.freeze.staleLocks", { files: joinList(ctx, locks) }), hint: t("checks.config.freeze.staleLocksHint") });
    return merge(ctx, freezeSpec, pieces);
  },
};

export const CONFIG_CHECKS: readonly DoctorCheck[] = [configLayersCheck, configMarketCheck, configFreezeCheck];
export const LANGUAGE_CHECKS: readonly DoctorCheck[] = [languageConfigCheck];
