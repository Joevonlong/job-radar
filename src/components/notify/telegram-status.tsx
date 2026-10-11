"use client";

import { Check, Copy, Send } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { TriggerButton } from "@/components/control/trigger-button";
import { EnvPresenceList } from "@/components/setup/env-presence";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DocLink } from "@/components/ui/doc-link";
import type { TelegramStatusView } from "@/lib/notify/telegram-status";
import { toastTone } from "@/lib/toast";

const BADGE = { configured: "status-good", missing: "status", partial: "status-warn", invalid: "status-warn" } as const;
const KNOWN_TEST_ERRORS = ["telegram_not_configured", "telegram_failed"] as const;

/** The setup command with a copy button (the command is the same for everyone: no value in it). */
function CommandLine({ command }: { command: string }) {
  const t = useTranslations("settings.telegramStatus");
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toastTone("success", t("copied"));
    } catch {
      toastTone("error", t("copyFailed"));
    }
  };
  return (
    <div className="flex max-w-full items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-[6px] border-bw border-border bg-soft px-2 py-1 font-mono text-data whitespace-nowrap text-ink" data-testid="telegram-setup-command">
        {command}
      </code>
      <Button type="button" size="sm" variant="outline" onClick={() => void copy()} aria-label={t("copy")} data-testid="telegram-setup-copy">
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span className="max-sm:sr-only">{t("copy")}</span>
      </Button>
    </div>
  );
}

/**
 * Telegram on Settings -> Notifications and in the setup wizard: whether the bot token and chat id are set (never their
 * values), the push switch, the last test message, and how to set it up on the host (`pnpm run setup --step telegram`).
 * The web cannot enter or change the values. `test`: show the test message button once both are set.
 */
export function TelegramStatus({ status, test = true, testDisabled = false }: { status: TelegramStatusView; test?: boolean; testDisabled?: boolean }) {
  const t = useTranslations("settings.telegramStatus");
  const format = useFormatter();
  const configured = status.state === "configured";
  const lastTest = status.lastTest;
  const testError = lastTest?.error ?? null;
  const testErrorText = testError !== null && (KNOWN_TEST_ERRORS as readonly string[]).includes(testError) ? t(`testErrors.${testError as (typeof KNOWN_TEST_ERRORS)[number]}`) : t("testErrors.other");

  return (
    <section className="flex flex-col gap-sp-2 rounded-card border-bw border-border bg-card px-4 py-3" data-testid="telegram-status" data-state={status.state} aria-labelledby="telegram-status-title">
      <div className="flex flex-wrap items-center gap-2">
        <Send aria-hidden className="size-4 text-ink" />
        <h3 id="telegram-status-title" className="text-label font-bold text-ink">
          {t("title")}
        </h3>
        <Badge variant={BADGE[status.state]} data-testid="telegram-status-badge">
          {t(`state.${status.state}`)}
        </Badge>
      </div>
      <EnvPresenceList env={status.env} />
      <ul className="flex flex-col gap-0.5 text-body-sm text-ink-2">
        {status.enabled !== null ? <li data-testid="telegram-status-enabled">{t(status.enabled ? "enabledOn" : "enabledOff")}</li> : null}
        <li data-testid="telegram-status-last-test">
          {lastTest === null
            ? t("lastTest.none")
            : lastTest.ok
              ? t("lastTest.ok", { at: lastTest.at === null ? "" : format.dateTime(new Date(lastTest.at), { dateStyle: "medium", timeStyle: "short" }) })
              : t("lastTest.failed", { at: lastTest.at === null ? "" : format.dateTime(new Date(lastTest.at), { dateStyle: "medium", timeStyle: "short" }), reason: testErrorText })}
        </li>
      </ul>

      {configured ? (
        <>
          {test ? (
            <div className="flex flex-col gap-sp-1">
              <TriggerButton kind="testTelegram" confirm disabled={testDisabled} />
            </div>
          ) : null}
          <p className="text-body-sm text-ink-2">{t("changeHint")}</p>
          <CommandLine command={status.command} />
        </>
      ) : (
        <div className="flex flex-col gap-sp-2" data-testid="telegram-guide">
          {status.state === "partial" || status.state === "invalid" ? (
            <p role="status" className="text-body-sm font-bold text-warning-text">
              {t(`problem.${status.state}`)}
            </p>
          ) : null}
          <ol className="flex list-decimal flex-col gap-sp-1 pl-5 text-body-sm text-ink">
            <li>{t("guide.botFather")}</li>
            <li className="flex flex-col gap-sp-1">
              <span>{t("guide.run")}</span>
              <CommandLine command={status.command} />
            </li>
            <li>{t("guide.paste")}</li>
            <li>{t("guide.restart")}</li>
          </ol>
          <p className="text-body-sm text-ink-2">
            {t.rich("guide.manual", {
              doc: (chunks) => <DocLink doc="telegram">{chunks}</DocLink>,
              code: (chunks) => <code className="font-mono text-data">{chunks}</code>,
            })}
          </p>
        </div>
      )}
    </section>
  );
}
