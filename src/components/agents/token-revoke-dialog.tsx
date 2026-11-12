"use client";

import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { revokeAgentTokenAction } from "@/app/settings/agents/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AgentTokenRow } from "@/lib/agent-access/settings-view";
import { toastTone } from "@/lib/toast";

import { SHEET_ON_PHONE } from "./stdio-dialog";

/** Asks before revoking: it cannot be undone, and the next HTTP request with the token is refused. */
export function TokenRevokeDialog({ token, onClose }: { token: AgentTokenRow | null; onClose: () => void }) {
  const t = useTranslations("agents.tokens.revokeDialog");
  const [pending, startTransition] = useTransition();

  function revoke(id: number) {
    startTransition(async () => {
      let status: string;
      try {
        status = (await revokeAgentTokenAction({ id })).status;
      } catch {
        status = "failed";
      }
      if (status === "revoked" || status === "not_found") {
        toastTone("success", t(status === "revoked" ? "done" : "notFound"));
        onClose();
      } else toastTone("error", t(status === "session_required" ? "sessionRequired" : "failed"));
    });
  }

  return (
    <Dialog open={token !== null} onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogContent className={SHEET_ON_PHONE} data-testid="token-revoke-dialog">
        <DialogHeader>
          <DialogTitle>{t("title", { name: token?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {token === null ? null : (
          <p className="font-mono text-data text-ink-2">{token.prefix}…</p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" disabled={pending}>
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="danger" disabled={pending || token === null} onClick={() => token && revoke(token.id)} data-testid="token-revoke-confirm">
            {pending ? t("revoking") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
