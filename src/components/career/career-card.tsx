import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveLocale } from "@/i18n/locale";
import { readCareerGate } from "@/lib/config/career-gate";
import { CareerStoreError } from "@/lib/career/contact/errors";
import { profileEntryCount, hasCareerContent } from "@/lib/career/schema/profile";
import { loadCareerProfile } from "@/lib/career/store/profile";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { formatFullTime } from "@/lib/format/time";
import { logActionFailure } from "@/lib/logging/action-failure";
import { careerErrorMessageKey } from "./error-messages";

export async function CareerCard() {
  if (!(await readCareerGate()).enabled) return null;
  const t = await getTranslations("career");
  const locale = resolveLocale(await getLocale());
  let loaded: Awaited<ReturnType<typeof loadCareerProfile>> | null = null;
  let code = "";
  try {
    loaded = await loadCareerProfile();
  } catch (error) {
    logActionFailure("careerCard", error);
    code = error instanceof CareerStoreError ? error.code : "profile_invalid";
  }
  return (
    <Card data-testid="career-card">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {loaded && loaded.baseHash === null && <p>{t("notCreated")}</p>}
        {loaded && loaded.baseHash !== null && (
          <>
            <p>{t("entries", { count: profileEntryCount(loaded.profile) })}</p>
            <p className="text-body-sm text-ink-2">
              {t("updated", { time: formatFullTime(loaded.updatedAt, { locale, timeZone: getDisplayTimeZone() }) })}
            </p>
          </>
        )}
        {!loaded && (
          <p role="alert" data-code={code}>
            {t(careerErrorMessageKey(code))}
          </p>
        )}
        {loaded && !hasCareerContent(loaded.profile) && <p className="text-body-sm" data-testid="career-card-hint"><Link href="/career" className="underline">{t("emptyHint")}</Link></p>}
        {(!loaded || hasCareerContent(loaded.profile)) && <Link href="/career" className="text-label underline">
          {t("open")}
        </Link>}
      </CardContent>
    </Card>
  );
}
