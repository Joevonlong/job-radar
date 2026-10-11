"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";

import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { FAVORITE_SORTS, type FavoriteSort } from "@/lib/jobs/constants";

/** Order of the favorites page as a Segmented control; lives in the URL (`?sort=starred|rank`, the default is not written). */
export function FavoritesSort({ active }: { active: FavoriteSort }) {
  const t = useTranslations("favorites.page");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(active);
  return (
    <Segmented
      aria-label={t("sortLabel")}
      value={shown}
      onValueChange={(value) => {
        const sort = FAVORITE_SORTS.find((s) => s === value);
        if (!sort) return;
        startTransition(() => {
          setShown(sort);
          router.replace(sort === "starred" ? "/favorites" : `/favorites?sort=${sort}`, { scroll: false });
        });
      }}
      data-testid="favorites-sort"
      data-pending={pending ? "true" : "false"}
    >
      {FAVORITE_SORTS.map((sort) => (
        <SegmentedItem key={sort} value={sort} data-sort={sort}>
          {t(`sort.${sort}`)}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}
