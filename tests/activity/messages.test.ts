import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { CALLBACK_RESULTS, EVENT_CODES, REASON_CODES, SPAN_NAMES, SPAN_STATUSES } from "@/lib/activity/names";
import { SAFE_ERROR_CODES } from "@/lib/activity/error-codes";
import { DISPLAY_STATUS_CODES } from "@/lib/activity/display-status";
import { activityLabel, messageKey } from "@/lib/activity/messages";
import { DELIVERY_DISPOSITIONS } from "@/lib/channels/delivery";
import type { JobAction } from "@/lib/notify/callbacks";
import { controlRequestKindEnum, controlRequestStatusEnum, runStatusEnum } from "@/lib/db/schema";

const actions = { interested: true, ignore: true, resume: true, favorite: true, unfavorite: true } satisfies Record<JobAction, true>;
const groups = { span: SPAN_NAMES, spanStatus: SPAN_STATUSES, event: EVENT_CODES, reason: REASON_CODES,
  error: [...SAFE_ERROR_CODES, "other"], status: DISPLAY_STATUS_CODES, callbackResult: CALLBACK_RESULTS,
  callbackAction: Object.keys(actions), disposition: DELIVERY_DISPOSITIONS, requestKind: controlRequestKindEnum.enumValues,
  requestStatus: controlRequestStatusEnum.enumValues, runStatus: runStatusEnum.enumValues };

for (const [locale, messages] of [["en", en], ["zh", zh]] as const) {
  describe(`activity messages in ${locale}`, () => {
    const t = createTranslator({ locale, messages, namespace: "activityLog" });
    for (const [group, codes] of Object.entries(groups)) {
      it(`translates every ${group} code through the UI key convention`, () => {
        for (const code of codes) {
          const key = `${group}.${messageKey(code)}`;
          expect(t.has(key as never), key).toBe(true);
          expect(activityLabel(t, group, code).trim(), key).not.toBe("");
        }
      });
    }
    it("contains unknown codes without echoing their text", () => {
      expect(activityLabel(t, "error", "secret.url")).toBe(t("error.other"));
      expect(activityLabel(t, "span", "secret.url")).toBe(t("unknown"));
      expect(activityLabel(t, "reason", "rate_limited")).toBe(t("error.rate_limited"));
    });
  });
}
