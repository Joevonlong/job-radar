"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export function CareerGuidance({ empty }: { empty: boolean }) {
  const t = useTranslations("career.guidance");
  const [collapsed, setCollapsed] = useState(false);
  const visible = empty || !collapsed;
  return <section className="flex flex-col gap-3 rounded-card border-bw border-grid p-4" data-testid="career-guidance">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-title-sm font-bold">{t("title")}</h2>
      {!empty && <Button variant="ghost" size="sm" aria-expanded={visible} onClick={() => setCollapsed(!collapsed)}>{t(visible ? "collapse" : "expand")}</Button>}
    </div>
    {visible && <div className="flex flex-col gap-2" data-testid="career-guidance-content">
      <p className="text-body-sm">{t("purpose")}</p>
      <p className="text-body-sm">{t("local")}</p>
      {empty && <ol className="list-inside list-decimal text-body-sm" data-testid="career-guidance-steps">
        <li>{t("upload")}</li><li>{t("review")}</li><li>{t("edit")}</li>
      </ol>}
    </div>}
  </section>;
}
