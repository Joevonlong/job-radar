"use client";

import { Star } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useFavoriteToggle } from "./use-favorite-toggle";

interface FavoriteButtonProps {
  jobId: number;
  title: string;
  /** What the server last said. */
  favorite: boolean;
  /** "labeled": the desktop action row (`☆ Favorite` / `★ Favorited`); "icon": the 44px star of the phone bar. */
  variant: "labeled" | "icon";
}

/** The star of the detail page. Optimistic; un-starring offers an undo. Independent of the application status. */
export function FavoriteButton({ jobId, title, favorite, variant }: FavoriteButtonProps) {
  const t = useTranslations("favorites.toggle");
  const { isFavorite, isSaving, toggle } = useFavoriteToggle([{ id: jobId, favorite }]);
  const on = isFavorite({ id: jobId, favorite });
  // data-saving is set from the press until the server answered (a navigation before that can cut the request off); the e2e waits for it
  const saving = isSaving({ id: jobId });
  const onClick = () => void toggle({ id: jobId, title }, !on);
  const star = <Star aria-hidden className={cn(on && "fill-current")} />;

  if (variant === "icon") {
    return (
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-[44px] shrink-0"
        aria-pressed={on}
        aria-label={on ? t("removeLabel", { title }) : t("addLabel", { title })}
        title={t("title")}
        onClick={onClick}
        data-saving={saving || undefined}
        data-testid="bar-favorite"
      >
        {star}
      </Button>
    );
  }
  return (
    <Button type="button" variant="default" size="md" aria-pressed={on} onClick={onClick} data-saving={saving || undefined} data-testid="detail-favorite">
      {star} {on ? t("remove") : t("add")}
    </Button>
  );
}
