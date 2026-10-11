"use client";

import { Download } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Download sources.yaml as it is (comments included) or its validated values as JSON. Proxy credentials are masked by the server. */
export function ExportMenu({ yamlAvailable, jsonAvailable }: { yamlAvailable: boolean; jsonAvailable: boolean }) {
  const t = useTranslations("sourcesRegistry.export");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="default" size="sm" data-testid="export-menu">
          <Download aria-hidden />
          {t("label")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild disabled={!yamlAvailable}>
          <a href="/sources/registry/export?format=yaml" download data-testid="export-yaml">
            {t("yaml")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild disabled={!jsonAvailable}>
          <a href="/sources/registry/export?format=json" download data-testid="export-json">
            {t("json")}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
