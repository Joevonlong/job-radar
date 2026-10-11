"use client";

import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isValidPattern, type VocabularyFieldError } from "@/lib/interests/vocabulary-draft";

interface PatternListProps {
  /** Id prefix of the rows. */
  id: string;
  values: string[];
  onChange: (next: string[]) => void;
  /** Field errors of the last save, by draft path; `path` is the path of the list, rows are `${path}.${index}`. */
  errors: Map<string, VocabularyFieldError>;
  path: string;
  /** `true` when the rows are regular expressions (checked while typing); false for plain names. */
  regex?: boolean;
  addLabel: string;
  rowLabel: string;
  emptyLabel: string;
}

/** A list of one-line strings, typically regular expressions: add, edit and remove rows. */
export function PatternList({ id, values, onChange, errors, path, regex = true, addLabel, rowLabel, emptyLabel }: PatternListProps) {
  const t = useTranslations("interests");
  const listError = errors.get(path);

  return (
    <div className="flex flex-col gap-2" data-testid={`list-${path}`}>
      {values.length === 0 ? <p className="text-muted-foreground text-xs">{emptyLabel}</p> : null}
      <ul className="flex flex-col gap-2">
        {values.map((value, index) => {
          const serverError = errors.get(`${path}.${index}`);
          const localInvalid = regex && value.trim() !== "" && !isValidPattern(value);
          const message = serverError ? t(`errors.${serverError.key}`, serverError.params) : localInvalid ? t("errors.regex") : null;
          return (
            <li key={index} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Input
                  id={`${id}-${index}`}
                  value={value}
                  aria-label={t("list.row", { label: rowLabel, n: index + 1 })}
                  aria-invalid={message !== null || undefined}
                  aria-describedby={message !== null ? `${id}-${index}-msg` : undefined}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-xs"
                  onChange={(event) => onChange(values.map((entry, i) => (i === index ? event.target.value : entry)))}
                />
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("list.remove", { label: rowLabel, n: index + 1 })} onClick={() => onChange(values.filter((_, i) => i !== index))}>
                  <X aria-hidden />
                </Button>
              </div>
              {message !== null ? (
                <p id={`${id}-${index}-msg`} role="alert" className="text-destructive text-xs">
                  {message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {listError ? (
        <p role="alert" className="text-destructive text-xs">
          {t(`errors.${listError.key}`, listError.params)}
        </p>
      ) : null}
      <div>
        <Button type="button" variant="outline" size="xs" onClick={() => onChange([...values, ""])}>
          <Plus aria-hidden /> {addLabel}
        </Button>
      </div>
    </div>
  );
}
