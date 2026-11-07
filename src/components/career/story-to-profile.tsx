"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";

import { addStoryToProfileAction } from "@/app/career/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StoryOption } from "@/lib/career/apply/from-story";
import { primaryText, type CareerProfile } from "@/lib/career/schema/profile";

type Saved = Extract<Awaited<ReturnType<typeof addStoryToProfileAction>>, { ok: true }>;
const ERRORS = ["stale", "story_present", "unknown_id", "limits", "disabled"] as const;

/** Adds one story from the experience library to an experience entry as a new bullet or summary wording. */
export function StoryToProfile({ stories, profile, baseHash, dirty, onSaved }: {
  stories: StoryOption[]; profile: CareerProfile; baseHash: string | null; dirty: boolean; onSaved: (saved: Saved) => void;
}) {
  const t = useTranslations("career.fromStory");
  const id = useId();
  const [storyId, setStoryId] = useState(stories[0]?.id ?? "");
  const [experienceId, setExperienceId] = useState(profile.experience[0]?.id ?? "");
  const [target, setTarget] = useState<"bullet" | "summary">("bullet");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const story = stories.find((item) => item.id === storyId) ?? null;
  const experience = profile.experience.find((item) => item.id === experienceId) ?? profile.experience[0] ?? null;

  async function add() {
    if (!story || !experience) return;
    setBusy(true); setFailure(null); setAdded(false);
    try {
      const result = await addStoryToProfileAction({ storyId: story.id, experienceId: experience.id, target, baseHash });
      if (!result.ok) { setFailure(result.code); return; }
      setAdded(true); onSaved(result);
    } catch { setFailure("unavailable"); }
    finally { setBusy(false); }
  }
  const errorKey = (ERRORS as readonly string[]).includes(failure ?? "") ? `errors.${failure as (typeof ERRORS)[number]}` as const : "errors.generic" as const;
  return (
    <Card data-testid="career-from-story" className="min-w-0">
      <CardHeader><CardTitle><h2>{t("title")}</h2></CardTitle></CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <p className="text-body-sm">{t("hint")}</p>
        {stories.length === 0 ? <p className="text-body-sm">{t("noStories")}</p> : profile.experience.length === 0 ? <p className="text-body-sm">{t("noExperience")}</p> : (
          <fieldset disabled={busy || dirty} className="flex min-w-0 flex-col gap-3">
            <label htmlFor={`${id}-story`} className="text-label">{t("story")}</label>
            <select id={`${id}-story`} className="border-border rounded-sm border bg-transparent p-1.5 text-body-sm" value={storyId} onChange={(event) => { setStoryId(event.target.value); setAdded(false); }} data-testid="career-from-story-story">
              {stories.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            <label htmlFor={`${id}-entry`} className="text-label">{t("experience")}</label>
            <select id={`${id}-entry`} className="border-border rounded-sm border bg-transparent p-1.5 text-body-sm" value={experience?.id ?? ""} onChange={(event) => { setExperienceId(event.target.value); setAdded(false); }} data-testid="career-from-story-entry">
              {profile.experience.map((item) => <option key={item.id} value={item.id}>{[item.company, primaryText(item.role)].filter(Boolean).join(" · ")}</option>)}
            </select>
            <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={t("target")}>
              {(["bullet", "summary"] as const).map((value) => (
                <label key={value} className="flex gap-2 text-body-sm">
                  <input type="radio" name={`${id}-target`} checked={target === value} onChange={() => setTarget(value)} />{t(value)}
                </label>
              ))}
            </div>
            {story && <blockquote className="border-border text-body-sm border-l-2 pl-3 break-words" data-testid="career-from-story-text">{story.text}</blockquote>}
            {story?.pii && <p role="alert" className="text-bad text-body-sm" data-testid="career-from-story-pii">{t("pii")}</p>}
            <Button variant="primary" className="self-start" disabled={!story || !experience} onClick={() => void add()} data-testid="career-from-story-add">{t("add")}</Button>
          </fieldset>
        )}
        {dirty && <p className="text-body-sm">{t("saveFirst")}</p>}
        {failure && <p role="alert" data-code={failure} className="text-bad break-words">{t(errorKey)}</p>}
        {added && <p role="status">{t("added")}</p>}
      </CardContent>
    </Card>
  );
}
