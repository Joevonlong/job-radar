import { getFormatter, getTranslations } from "next-intl/server";

import type { DiskStatus } from "@/lib/ops/disk";

import { Banner } from "./banner";

/** Low disk space on the volume the database lives on (the same thresholds as `pnpm run doctor`: schedule.yaml `doctor`). Nothing is shown while there is enough. */
export async function DiskNotice({ disk }: { disk: DiskStatus | null }) {
  if (disk === null || disk.level === "ok") return null;
  const [t, format] = await Promise.all([getTranslations("sources.disk"), getFormatter()]);
  const fail = disk.level === "fail";
  return (
    <Banner tone={fail ? "bad" : "warn"} testId="disk-notice" data-level={disk.level} data-source={disk.source}>
      {t(fail ? "fail" : "warn", {
        free: format.number(disk.freeGb, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        percent: disk.percent,
        limit: fail ? disk.minGb : disk.warnGb,
      })}{" "}
      {disk.source === "host" ? t("sourceHost", { path: disk.path ?? "" }) : t("sourceLocal")}
    </Banner>
  );
}
