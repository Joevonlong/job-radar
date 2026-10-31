"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WriterStoriesLimits } from "@/lib/config/schemas/writer";
import { changedPaths } from "@/lib/draft-diff";
import type { FieldError } from "@/lib/profile/draft";
import type { ProfileActionState } from "@/lib/profile/types";
import { EMPTY_STORY, storyPii, type StoriesDraft, type StoryDraft } from "@/lib/stories/draft";

import { ErrorText, Field, TagInput, describedBy, fieldErrorMap } from "./fields";
import { FormCard } from "./form-card";

interface StoriesCardProps {
  initial: StoriesDraft;
  hash: string;
  state: ProfileActionState;
  pending: boolean;
  limits: WriterStoriesLimits;
  onSave: (draft: StoriesDraft) => void;
}

/** A story with the key React uses for its row (new stories have no id yet). */
interface Row {
  key: string;
  story: StoryDraft;
}

function rowsOf(draft: StoriesDraft): Row[] {
  return draft.stories.map((story, index) => ({ key: story.id === "" ? `new-${index}` : story.id, story }));
}

/** The experience library on /me: list, add, edit, delete and reorder; saved as a whole like the other profile forms. */
export function StoriesCard({ initial, hash, state, pending, limits, onSave }: StoriesCardProps) {
  const t = useTranslations("profile");
  const listId = useId();
  const [rows, setRows] = useState<Row[]>(() => rowsOf(initial));
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const nextKey = useRef(0);
  const errors = fieldErrorMap(state, "stories", hash);
  const draft: StoriesDraft = { stories: rows.map((row) => row.story) };
  const dirtyCount = changedPaths(draft, initial).length;
  const full = rows.length >= limits.max_items;

  function toggle(key: string, value: boolean) {
    setOpen((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function update(index: number, patch: Partial<StoryDraft>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, story: { ...row.story, ...patch } } : row)));
  }

  function move(index: number, by: -1 | 1) {
    setRows((current) => {
      const target = index + by;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function add() {
    nextKey.current += 1;
    const key = `added-${nextKey.current}`;
    setRows((current) => [...current, { key, story: { ...EMPTY_STORY } }]);
    toggle(key, true);
  }

  return (
    <FormCard
      kind="stories"
      title={t("sections.stories.title")}
      description={t("sections.stories.description")}
      hash={hash}
      state={state}
      pending={pending}
      dirtyCount={dirtyCount}
      onSubmit={() => onSave(draft)}
      onReset={() => {
        setRows(rowsOf(initial));
        setOpen(new Set());
      }}
    >
      {rows.length === 0 ? <p className="text-ink-2 text-body-sm">{t("stories.empty")}</p> : null}
      {rows.length > 0 ? (
        <ol className="flex flex-col gap-3" aria-label={t("sections.stories.title")}>
          {rows.map((row, index) => {
            const rowErrors = [...errors.keys()].some((path) => path.startsWith(`stories.${index}.`));
            return (
              <StoryRow
                key={row.key}
                story={row.story}
                index={index}
                count={rows.length}
                open={open.has(row.key) || rowErrors}
                errors={errors}
                limits={limits}
                onToggle={(value) => toggle(row.key, value)}
                onChange={(patch) => update(index, patch)}
                onMove={(by) => move(index, by)}
                onRemove={() => setRows((current) => current.filter((_, i) => i !== index))}
              />
            );
          })}
        </ol>
      ) : null}
      <ErrorText id={`${listId}-msg`} error={errors.get("stories")} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={full} onClick={add}>
          <Plus aria-hidden />
          {t("stories.add")}
        </Button>
        <span className="text-ink-2 text-body-sm font-mono tabular-nums">{t("stories.count", { count: rows.length, max: limits.max_items })}</span>
      </div>
    </FormCard>
  );
}

interface StoryRowProps {
  story: StoryDraft;
  index: number;
  count: number;
  open: boolean;
  errors: Map<string, FieldError>;
  limits: WriterStoriesLimits;
  onToggle: (open: boolean) => void;
  onChange: (patch: Partial<StoryDraft>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

function StoryRow({ story, index, count, open, errors, limits, onToggle, onChange, onMove, onRemove }: StoryRowProps) {
  const t = useTranslations("profile.stories");
  const base = useId();
  const bodyId = `${base}-body`;
  const pii = storyPii(story);
  const title = story.title.trim() === "" ? t("untitled") : story.title;
  const at = (field: string) => errors.get(`stories.${index}.${field}`);

  return (
    <li className="border-border bg-card rounded-card border-bw" data-testid="story-row">
      <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-title-sm font-bold [overflow-wrap:anywhere]">{title}</p>
          <div className="text-ink-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
            {story.period.trim() !== "" ? <span>{story.period}</span> : null}
            {story.source !== "manual" ? <Badge variant="status">{t(`source.${story.source}`)}</Badge> : null}
            {pii.length > 0 ? (
              <Badge variant="status-warn">
                <AlertTriangle aria-hidden className="size-3" />
                {t("piiBadge")}
              </Badge>
            ) : null}
          </div>
          {story.skills.length > 0 ? (
            <ul className="flex flex-wrap gap-1" aria-label={t("fields.skills")}>
              {story.skills.map((skill) => (
                <li key={skill}>
                  <Badge variant="skill">{skill}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="xs" variant="outline" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(!open)}>
            <Pencil aria-hidden />
            {open ? t("done") : t("edit")}
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t("moveUp", { title })} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp aria-hidden />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t("moveDown", { title })} disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown aria-hidden />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t("remove", { title })} onClick={onRemove}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>
      {open ? (
        <div id={bodyId} className="border-border flex flex-col gap-4 border-t-bw px-3 py-3">
          {pii.length > 0 ? (
            <p role="status" className="border-warn bg-card flex items-start gap-2 rounded-tag border-bw px-3 py-2 text-body-sm">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{t("piiWarning", { kinds: pii.map((kind) => t(`pii.${kind}`)).join(", ") })}</span>
            </p>
          ) : null}
          <TextField id={`${base}-title`} label={t("fields.title")} hint={t("hints.max", { max: limits.title_max_chars })} error={at("title")} value={story.title} max={limits.title_max_chars} onChange={(title) => onChange({ title })} />
          <TextField id={`${base}-what`} label={t("fields.what")} hint={t("hints.what", { max: limits.text_max_chars })} error={at("what")} value={story.what} max={limits.text_max_chars} multiline onChange={(what) => onChange({ what })} />
          <TextField id={`${base}-result`} label={t("fields.result")} hint={t("hints.max", { max: limits.text_max_chars })} error={at("result")} value={story.result} max={limits.text_max_chars} multiline onChange={(result) => onChange({ result })} />
          <ListField id={`${base}-metrics`} label={t("fields.metrics")} hint={t("hints.metrics")} error={at("metrics")} values={story.metrics} sentences onChange={(metrics) => onChange({ metrics })} />
          <ListField id={`${base}-skills`} label={t("fields.skills")} hint={t("hints.list")} error={at("skills")} values={story.skills} onChange={(skills) => onChange({ skills })} />
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <TextField id={`${base}-period`} label={t("fields.period")} hint={t("hints.period")} error={at("period")} value={story.period} max={limits.title_max_chars} onChange={(period) => onChange({ period })} />
            <TextField id={`${base}-language`} label={t("fields.language")} hint={t("hints.language")} error={at("language")} value={story.language} max={3} mono onChange={(language) => onChange({ language })} />
          </div>
          <ListField id={`${base}-tags`} label={t("fields.tags")} hint={t("hints.list")} error={at("tags")} values={story.tags} onChange={(tags) => onChange({ tags })} />
        </div>
      ) : null}
    </li>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  hint: string;
  error: FieldError | undefined;
  value: string;
  max: number;
  multiline?: boolean;
  mono?: boolean;
  onChange: (value: string) => void;
}

function TextField({ id, label, hint, error, value, max, multiline = false, mono = false, onChange }: TextFieldProps) {
  const common = {
    id,
    value,
    maxLength: max,
    autoComplete: "off",
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(id, true, error),
  } as const;
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {multiline ? (
        <Textarea {...common} rows={3} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input {...common} className={mono ? "w-24 font-mono" : undefined} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  );
}

interface ListFieldProps {
  id: string;
  label: string;
  hint: string;
  error: FieldError | undefined;
  values: string[];
  /** Entries are phrases that may contain commas (metrics): only Enter ends one, and repeats are compared as typed. */
  sentences?: boolean;
  onChange: (values: string[]) => void;
}

function ListField({ id, label, hint, error, values, sentences = false, onChange }: ListFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <TagInput id={id} values={values} onChange={onChange} invalid={error !== undefined} describedBy={describedBy(id, true, error)} {...(sentences ? { dedupe: "exact", commitOnComma: false } : {})} />
    </Field>
  );
}
